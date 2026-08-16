from __future__ import annotations

import asyncio
import json
import logging
import math
import uuid
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Annotated, Any, Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from .analytics import (
    active_trade_routes,
    current_play_session,
    deterministic_action_specs,
    finance_analysis,
    finance_history,
    finance_latest,
    inventory_history,
    inventory_history_group,
    inventory_latest,
    latest_complete_snapshot,
    production_chains,
    resolve_campaign_id,
    route_issues_latest,
    snapshot_meta,
    suggested_routes,
    trade_opportunities,
    workforce_latest,
)
from .actions import action_dict, sync_actions
from .advisor import ask_advisor, conversation_dict
from .catalog import catalog_summary, load_catalog
from .config import Settings, settings as default_settings
from .db import Base, SessionLocal, engine
from .ingestion import TelemetryTailer
from .normalizer import refresh_materialized_state
from .models import (
    Area,
    AreaLocation,
    AreaPopulationObservation,
    AreaProductObservation,
    AreaProductPolicy,
    AreaSnapshot,
    AreaWorkforceObservation,
    Campaign,
    CompanionSetting,
    IngestionCursor,
    ManagementAction,
    PlaySession,
    Product,
    SnapshotBatch,
    TelemetryRaw,
    TradePlan,
    TradePlanItem,
    TradeRouteLink,
    AdvisorConversation,
    AdvisorMessage,
    utcnow,
)
from .trade_network import (
    build_trade_network,
    new_route_identity,
    route_link_dict,
    sync_trade_plan_runtime,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger(__name__)


def get_database(request: Request) -> Iterator[Session]:
    with request.app.state.session_factory() as session:
        yield session


Database = Annotated[Session, Depends(get_database)]


class EventBroker:
    def __init__(self) -> None:
        self._subscribers: set[asyncio.Queue[dict]] = set()

    async def publish_snapshot(self, snapshot_id: int) -> None:
        event = {"event": "snapshot_completed", "snapshot_id": snapshot_id}
        for queue in tuple(self._subscribers):
            if queue.full():
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            queue.put_nowait(event)

    async def subscribe(self) -> AsyncIterator[dict]:
        queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=8)
        self._subscribers.add(queue)
        try:
            while True:
                try:
                    yield await asyncio.wait_for(queue.get(), timeout=15)
                except TimeoutError:
                    yield {"event": "heartbeat", "at": datetime.now(UTC).isoformat()}
        finally:
            self._subscribers.discard(queue)


class CampaignPatch(BaseModel):
    display_name: str = Field(min_length=1, max_length=120)


class CampaignUpdate(BaseModel):
    campaign_id: str
    display_name: str | None = Field(default=None, min_length=1, max_length=120)
    play_session_id: str | None = None

    @model_validator(mode="after")
    def includes_a_change(self) -> "CampaignUpdate":
        if self.display_name is None and self.play_session_id is None:
            raise ValueError("display_name or play_session_id is required")
        return self


class PolicyWrite(BaseModel):
    campaign_id: str
    area_pk: int
    product_guid: str
    low_target: float | None = Field(default=None, ge=0)
    high_target: float | None = Field(default=None, ge=0)
    priority: int = Field(default=0, ge=-10, le=10)
    excluded: bool = False

    @model_validator(mode="after")
    def targets_are_ordered(self) -> "PolicyWrite":
        if (
            self.low_target is not None
            and self.high_target is not None
            and self.high_target < self.low_target
        ):
            raise ValueError("high_target must be greater than or equal to low_target")
        return self


class MapPositionWrite(BaseModel):
    region_guid: str | None = None
    x: float | None = Field(default=None, ge=0, le=1)
    y: float | None = Field(default=None, ge=0, le=1)
    clear: bool = False

    @model_validator(mode="after")
    def complete_position(self) -> "MapPositionWrite":
        if not self.clear and (self.region_guid is None or self.x is None or self.y is None):
            raise ValueError("region_guid, x, and y are required unless clear is true")
        return self


class ActiveCampaignWrite(BaseModel):
    campaign_id: str


class ActionPatch(BaseModel):
    status: Literal["active", "accepted", "snoozed", "dismissed", "completed"]
    snooze_minutes: int | None = Field(default=None, ge=1, le=10080)


class TradePlanGoodWrite(BaseModel):
    product_guid: str
    amount: float = Field(gt=0)


class TradePlanCreate(BaseModel):
    campaign_id: str | None = None
    source_area_pk: int
    destination_area_pk: int
    goods: list[TradePlanGoodWrite] = Field(min_length=1, max_length=113)
    plan_kind: Literal["emergency_transfer", "recurring_supply"] = "emergency_transfer"
    usable_ship_capacity: float | None = Field(default=None, gt=0)
    expected_round_trip_minutes: float | None = Field(default=None, gt=0)
    reason: str | None = Field(default=None, max_length=1000)
    evidence: dict[str, Any] = Field(default_factory=dict)


class TradePlanPatch(BaseModel):
    status: Literal["planned", "implemented", "implemented_unverified", "completed", "dismissed"] | None = None
    plan_kind: Literal["emergency_transfer", "recurring_supply"] | None = None
    usable_ship_capacity: float | None = Field(default=None, gt=0)
    expected_round_trip_minutes: float | None = Field(default=None, gt=0)

    @model_validator(mode="after")
    def includes_a_change(self) -> "TradePlanPatch":
        clearable_assumption = bool(
            self.model_fields_set & {"usable_ship_capacity", "expected_round_trip_minutes"}
        )
        if not self.model_fields_set or (
            self.status is None and self.plan_kind is None and not clearable_assumption
        ):
            raise ValueError("at least one trade-plan field is required")
        return self


class RouteLinkWrite(BaseModel):
    campaign_id: str | None = None
    route_key: str
    source_area_pk: int
    destination_area_pk: int
    trade_plan_id: str | None = None


class RouteLinkPatch(BaseModel):
    route_key: str | None = None
    source_area_pk: int | None = None
    destination_area_pk: int | None = None
    trade_plan_id: str | None = None

    @model_validator(mode="after")
    def includes_a_change(self) -> "RouteLinkPatch":
        clears_plan = "trade_plan_id" in self.model_fields_set
        if not self.model_fields_set or (
            self.route_key is None
            and self.source_area_pk is None
            and self.destination_area_pk is None
            and not clears_plan
        ):
            raise ValueError("at least one route-link field is required")
        return self


class AdvisorMessageWrite(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    campaign_id: str | None = None
    conversation_id: str | None = None


class ActionView(BaseModel):
    action_id: str
    campaign_id: str
    kind: str
    severity: str
    title: str
    summary: str
    evidence: dict[str, Any]
    deep_link: str | None
    status: str
    snoozed_until: str | None
    first_seen_at: str
    last_seen_at: str
    resolved_at: str | None


class ActionsResponse(BaseModel):
    campaign_id: str | None
    items: list[ActionView]


class TradePlanView(BaseModel):
    trade_plan_id: str
    campaign_id: str
    source_area_pk: int
    source_area_name: str
    destination_area_pk: int
    destination_area_name: str
    status: str
    plan_kind: Literal["emergency_transfer", "recurring_supply"]
    route_tag: str
    suggested_route_name: str
    usable_ship_capacity: float | None
    expected_round_trip_minutes: float | None
    estimated_required_ships: int | None
    runtime_status: str
    runtime_freshness: str
    goods_verification: str
    last_runtime_match_at: str | None
    reason: str | None
    evidence: dict[str, Any]
    goods: list[dict[str, Any]]
    created_at: str
    updated_at: str


class TradePlansResponse(BaseModel):
    campaign_id: str | None
    items: list[TradePlanView]


class RouteLinkView(BaseModel):
    link_id: str
    campaign_id: str
    route_key: str
    route_name: str
    ship_ids: list[str]
    trade_plan_id: str | None
    source_area_pk: int
    source_area_name: str
    destination_area_pk: int
    destination_area_name: str
    link_method: Literal["tag", "manual", "route_name"]
    first_seen_at: str
    last_seen_at: str
    updated_at: str


class TradeNetworkGoodEvidenceView(BaseModel):
    product_guid: str
    product_name: str | None
    amount: float | None
    evidence_kind: str
    trade_plan_id: str | None = None
    ship_id: str | None = None
    area_id: str | None = None
    stop_ordinal: int | None = None
    observed_at: str | None = None


class TradeNetworkPlanEvidenceView(BaseModel):
    trade_plan_id: str
    plan_kind: Literal["emergency_transfer", "recurring_supply"]
    workflow_status: str
    runtime_status: str
    runtime_freshness: str
    route_tag: str | None
    suggested_route_name: str | None
    reason: str | None
    goods: list[TradeNetworkGoodEvidenceView]


class TradeNetworkNodeView(BaseModel):
    node_id: str
    area_pk: int
    area_name: str
    region: Literal["latium", "albion"] | None
    severity: Literal["critical", "warning", "stable"]
    pressure_count: int
    route_issue_count: int
    running_route_count: int
    paused_route_count: int
    planned_route_count: int
    stock_health: dict[str, Any]
    important_goods: list[dict[str, Any]]
    pressure_signals: list[dict[str, Any]]


class TradeNetworkEndpointEvidenceView(BaseModel):
    kind: str
    trade_plan_id: str | None = None
    link_id: str | None = None


class TradeNetworkEdgeSummaryView(BaseModel):
    goods: int
    routes: int
    ships: int
    plans: int


class TradeNetworkEdgeView(BaseModel):
    edge_id: str
    source_area_pk: int
    source_area_name: str
    destination_area_pk: int
    destination_area_name: str
    scope: Literal["latium", "albion", "cross_region", "unknown"]
    status: Literal["running", "partially_paused", "paused", "issue", "planned", "inactive", "historical", "unknown"]
    severity: Literal["critical", "warning", "stable"]
    freshness: Literal["live", "stale", "historical"]
    goods_verification: Literal["planned_only", "route_name_only", "configured", "unavailable"]
    endpoint_evidence: list[TradeNetworkEndpointEvidenceView]
    plans: list[TradeNetworkPlanEvidenceView]
    routes: list[ActiveTradeRouteView]
    ships: list[ActiveTradeRouteShipView]
    planned_goods: list[TradeNetworkGoodEvidenceView]
    route_name_goods: list[TradeNetworkGoodEvidenceView]
    configured_goods: list[TradeNetworkGoodEvidenceView]
    cargo_aboard: list[TradeNetworkGoodEvidenceView]
    issues: list[dict[str, Any]]
    actions: list[dict[str, Any]]
    summary: TradeNetworkEdgeSummaryView


class TradeNetworkGraphView(BaseModel):
    nodes: list[TradeNetworkNodeView]
    edges: list[TradeNetworkEdgeView]


class InventoryHistoryPointView(BaseModel):
    snapshot_id: int
    play_session_id: str
    observed_at: str
    play_time: float | None
    stock: float | None
    available_stock: float | None
    capacity: float | None
    sample_kind: Literal["observed", "carried_forward"]


class InventoryHistorySeriesView(BaseModel):
    product_guid: str
    items: list[InventoryHistoryPointView]


class InventoryHistoryGroupResponse(BaseModel):
    meta: dict[str, Any]
    catalog: dict[str, Any]
    scope: Literal["area_product_group"]
    area_pk: int
    product_guids: list[str]
    series: list[InventoryHistorySeriesView]


class TradeNetworkGraphsView(BaseModel):
    latium: TradeNetworkGraphView
    albion: TradeNetworkGraphView
    cross_region: TradeNetworkGraphView


class TradeNetworkResponse(BaseModel):
    meta: dict[str, Any]
    catalog: dict[str, Any]
    campaign_id: str | None
    graphs: TradeNetworkGraphsView
    unmapped_routes: list[ActiveTradeRouteView]
    capabilities: dict[str, bool]
    evidence_notice: str


class AreaView(BaseModel):
    area_pk: int
    area_id: str
    name: str
    region_guid: str | None
    game_session_guid: str | None
    region_evidence: str | None
    first_seen_at: str
    last_seen_at: str
    persistent: bool
    telemetry_active: bool
    position: dict[str, float] | None
    position_source: str | None
    location_status: str
    location_error: str | None
    manual_placement: bool
    latest_observation: dict[str, Any]


class AreasResponse(BaseModel):
    meta: dict[str, Any]
    catalog: dict[str, Any]
    campaign_id: str | None
    items: list[AreaView]


class FinanceResponse(BaseModel):
    meta: dict[str, Any]
    catalog: dict[str, Any]
    finance: dict[str, Any] | None
    balance_analysis: dict[str, Any] | None


class FinanceHistoryResponse(BaseModel):
    meta: dict[str, Any]
    catalog: dict[str, Any]
    items: list[dict[str, Any]]


class TradeOpportunitiesResponse(BaseModel):
    meta: dict[str, Any]
    catalog: dict[str, Any]
    items: list[dict[str, Any]]
    suggested_routes: list[dict[str, Any]]
    notice: str


class ActiveTradeRouteShipView(BaseModel):
    ship_id: str
    ship_name: str | None
    ship_guid: str | None
    game_session_guid: str | None
    area_id: str | None
    is_paused: bool | None
    on_regular_route: bool | None
    loading_speed_factor: float | None


class ActiveTradeRouteView(BaseModel):
    route_key: str
    route_name: str
    identity_scope: Literal["mutable_route_name"]
    evidence_kind: Literal["assigned_ships", "issue_only"]
    status: Literal["running", "partially_paused", "paused", "issue_reported"]
    is_active_last_observed: bool | None
    assigned_ship_count: int | None
    paused_ship_count: int | None
    regular_ship_count: int | None
    game_session_guid: str | None
    region_guid: str | None
    observed_at: str | None
    freshness_seconds: float | None
    is_stale: bool
    freshness: Literal["live", "stale", "historical"] | None = None
    relink_suggestions: list[dict[str, Any]] = Field(default_factory=list)
    issues: list[dict[str, Any]]
    ships: list[ActiveTradeRouteShipView]


class ActiveTradeRoutesResponse(BaseModel):
    meta: dict[str, Any]
    campaign_id: str | None
    telemetry_status: Literal["success", "failed", "not_observed"]
    scope: str
    identity_notice: str
    capabilities: dict[str, bool]
    counts: dict[str, int]
    items: list[ActiveTradeRouteView]


class ProductionChainsResponse(BaseModel):
    meta: dict[str, Any]
    catalog: dict[str, Any]
    chains: list[dict[str, Any]]


class DashboardOverviewResponse(BaseModel):
    meta: dict[str, Any]
    catalog: dict[str, Any]
    finance: dict[str, Any] | None
    balance_analysis: dict[str, Any] | None
    actions: list[ActionView]
    suggested_routes: list[dict[str, Any]]
    signals: list[dict[str, Any]]
    transfer_candidates: list[dict[str, Any]]
    route_issues: list[dict[str, Any]]
    workforce_shortages: list[dict[str, Any]]
    counts: dict[str, int]
    language: dict[str, str]


class ActiveCampaignView(BaseModel):
    campaign_id: str


class AdvisorMessageView(BaseModel):
    message_id: int
    role: str
    content: str
    action_ids: list[str]
    created_at: str


class AdvisorConversationView(BaseModel):
    conversation_id: str
    campaign_id: str
    title: str | None
    created_at: str
    updated_at: str
    messages: list[AdvisorMessageView]
    available: bool | None = None
    error: str | None = None


def create_app(
    app_settings: Settings = default_settings,
    session_factory: sessionmaker[Session] = SessionLocal,
) -> FastAPI:
    broker = EventBroker()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if session_factory is SessionLocal:
            Base.metadata.create_all(engine)
        with session_factory() as session:
            load_catalog(session, app_settings.catalog_path)
            refresh_materialized_state(session)
            session.commit()
        tailer = None
        tailer_task = None
        if app_settings.enable_tailer:
            tailer = TelemetryTailer(
                telemetry_dir=app_settings.telemetry_dir,
                glob_pattern=app_settings.telemetry_glob,
                poll_interval=app_settings.poll_interval_seconds,
                session_factory=session_factory,
                on_snapshot=broker.publish_snapshot,
            )
            tailer_task = asyncio.create_task(tailer.run(), name="anno-telemetry-tailer")
        app.state.tailer = tailer
        try:
            yield
        finally:
            if tailer is not None:
                tailer.stop()
            if tailer_task is not None:
                await tailer_task

    app = FastAPI(
        title="Anno Companion Data API",
        version="1.2.0",
        description="Observed Anno 117 economy telemetry and deterministic management analytics.",
        lifespan=lifespan,
    )
    app.state.settings = app_settings
    app.state.session_factory = session_factory
    app.state.broker = broker

    @app.get("/healthz", tags=["system"])
    def healthz() -> dict:
        return {"status": "ok"}

    @app.get("/api/v1/status", tags=["system"])
    def status(database: Database) -> dict:
        play = current_play_session(database)
        snapshot = latest_complete_snapshot(database)
        cursors = database.scalars(select(IngestionCursor).order_by(IngestionCursor.source_path)).all()
        parse_errors = database.scalar(
            select(func.count()).select_from(TelemetryRaw).where(
                TelemetryRaw.parse_status.in_(["parse_error", "normalization_error"])
            )
        ) or 0
        path = app_settings.database_path
        return {
            "service": "anno-companion-data",
            "status": "ok",
            "database": {
                "path": str(path),
                "exists": path.exists(),
                "size_bytes": path.stat().st_size if path.exists() else 0,
                "journal_mode": "WAL",
            },
            "telemetry": {
                "directory": str(app_settings.telemetry_dir),
                "glob": app_settings.telemetry_glob,
                "parse_error_count": parse_errors,
                "sources": [
                    {
                        "path": cursor.source_path,
                        "fingerprint": cursor.source_fingerprint,
                        "byte_offset": cursor.byte_offset,
                        "file_size": cursor.file_size,
                        "last_read_at": cursor.last_read_at.isoformat() if cursor.last_read_at else None,
                        "last_error": cursor.last_error,
                    }
                    for cursor in cursors
                ],
            },
            "play_session": _play_session_dict(play),
            "selected_campaign_id": resolve_campaign_id(database),
            "latest_snapshot": snapshot_meta(
                snapshot, stale_after_seconds=app_settings.stale_after_seconds
            ),
            "catalog": catalog_summary(database, play.static_release_id if play else None),
            "advisor": {
                "configured": bool(app_settings.openai_api_key),
                "model": app_settings.openai_model,
                "reasoning_effort": app_settings.openai_reasoning_effort,
                "on_demand_only": True,
            },
        }

    @app.get("/api/v1/campaigns", tags=["identity"])
    def campaigns(database: Database) -> list[dict]:
        rows = database.scalars(select(Campaign).order_by(Campaign.created_at.desc())).all()
        return [
            {
                "campaign_id": row.campaign_id,
                "display_name": row.display_name,
                "game_seed": row.game_seed,
                "participant_guid": row.participant_guid,
                "identity_method": row.identity_method,
                "identity_confidence": row.identity_confidence,
                "created_at": row.created_at.isoformat(),
                "archived_at": row.archived_at.isoformat() if row.archived_at else None,
            }
            for row in rows
        ]

    @app.patch("/api/v1/campaigns/{campaign_id}", tags=["identity"])
    def update_campaign(campaign_id: str, patch: CampaignPatch, database: Database) -> dict:
        campaign = database.get(Campaign, campaign_id)
        if campaign is None:
            raise HTTPException(status_code=404, detail="campaign not found")
        campaign.display_name = patch.display_name.strip()
        campaign.identity_confidence = "user_confirmed"
        database.commit()
        return {"campaign_id": campaign.campaign_id, "display_name": campaign.display_name}

    @app.patch("/api/v1/campaigns", tags=["identity"])
    def patch_campaign(update_request: CampaignUpdate, database: Database) -> dict:
        campaign = database.get(Campaign, update_request.campaign_id)
        if campaign is None:
            raise HTTPException(status_code=404, detail="campaign not found")
        if update_request.display_name is not None:
            campaign.display_name = update_request.display_name.strip()
            campaign.identity_confidence = "user_confirmed"
        reassigned_session = None
        if update_request.play_session_id is not None:
            play = database.get(PlaySession, update_request.play_session_id)
            if play is None:
                raise HTTPException(status_code=404, detail="play session not found")
            if play.campaign_id != campaign.campaign_id:
                _reassign_play_session(database, play, campaign)
            reassigned_session = play.play_session_id
        database.commit()
        return {
            "campaign_id": campaign.campaign_id,
            "display_name": campaign.display_name,
            "play_session_id": reassigned_session,
        }

    @app.get("/api/v1/areas", tags=["economy"], response_model=AreasResponse)
    def areas(database: Database, campaign_id: str | None = None) -> dict:
        effective_campaign = resolve_campaign_id(database, campaign_id)
        play = current_play_session(database, effective_campaign)
        snapshot = latest_complete_snapshot(database, effective_campaign)
        meta = snapshot_meta(snapshot, stale_after_seconds=app_settings.stale_after_seconds)
        coverage = _catalog_for_snapshot(database, snapshot)
        if effective_campaign is None:
            return {"meta": meta, "catalog": coverage, "campaign_id": None, "items": []}
        rows = database.scalars(
            select(Area)
            .where(Area.campaign_id == effective_campaign)
            .order_by(Area.latest_name, Area.area_id_raw)
        ).all()
        return {
            "meta": meta,
            "catalog": coverage,
            "campaign_id": effective_campaign,
            "items": [
                _area_dict(database, row, telemetry_active=play is not None)
                for row in rows
            ],
        }

    @app.put("/api/v1/areas/{area_pk}/map-position", tags=["economy"], response_model=AreaView)
    def put_map_position(area_pk: int, position: MapPositionWrite, database: Database) -> dict:
        area = database.get(Area, area_pk)
        if area is None:
            raise HTTPException(status_code=404, detail="area not found")
        location = database.get(AreaLocation, area_pk)
        if location is None:
            location = AreaLocation(area_pk=area_pk)
            database.add(location)
        if position.clear:
            location.manual_region_guid = None
            location.manual_x = None
            location.manual_y = None
            location.manual_updated_at = None
        else:
            location.manual_region_guid = position.region_guid
            location.manual_x = position.x
            location.manual_y = position.y
            location.manual_updated_at = utcnow()
        database.commit()
        return _area_dict(database, area, telemetry_active=current_play_session(database, area.campaign_id) is not None)

    @app.get("/api/v1/products", tags=["catalog"])
    def products(database: Database) -> dict:
        play = current_play_session(database)
        snapshot = latest_complete_snapshot(database)
        release = play.static_release_id if play else catalog_summary(database).get("release_id")
        rows = database.scalars(
            select(Product).where(Product.release_id == release).order_by(Product.category, Product.name)
        ).all() if release else []
        return {
            "meta": snapshot_meta(snapshot, stale_after_seconds=app_settings.stale_after_seconds),
            "catalog": catalog_summary(database, release),
            "items": [
                {
                    "product_guid": row.product_guid,
                    "name": row.name,
                    "category": row.category,
                    "icon": row.icon,
                    "telemetry_enabled": row.telemetry_enabled,
                }
                for row in rows
            ],
        }

    @app.get("/api/v1/inventory/latest", tags=["economy"])
    def latest_inventory(database: Database, campaign_id: str | None = None) -> dict:
        return _inventory(database, campaign_id, app_settings)

    @app.get("/api/v1/inventory/history", tags=["economy"])
    def history(
        database: Database,
        area_pk: int,
        product_guid: str,
        limit: int = Query(default=240, ge=2, le=2000),
    ) -> dict:
        area = database.get(Area, area_pk)
        snapshot = latest_complete_snapshot(database, area.campaign_id if area else None)
        points = (
            inventory_history(
                database,
                area_pk=area_pk,
                product_guid=product_guid,
                play_session_id=snapshot.play_session_id,
                limit=limit,
            )
            if snapshot is not None
            else []
        )
        return {
            "meta": snapshot_meta(snapshot, stale_after_seconds=app_settings.stale_after_seconds),
            "catalog": _catalog_for_snapshot(database, snapshot),
            "scope": "area_product",
            "area_pk": area_pk,
            "product_guid": product_guid,
            "items": points,
        }

    @app.get(
        "/api/v1/inventory/history/group",
        tags=["economy"],
        response_model=InventoryHistoryGroupResponse,
    )
    def history_group(
        database: Database,
        area_pk: int,
        product_guid: list[str] = Query(...),
        limit: int = Query(default=240, ge=2, le=2000),
    ) -> dict:
        unique_guids = list(dict.fromkeys(product_guid))
        if not unique_guids or len(unique_guids) > 40:
            raise HTTPException(status_code=422, detail="select between 1 and 40 products")
        area = database.get(Area, area_pk)
        snapshot = latest_complete_snapshot(database, area.campaign_id if area else None)
        series = (
            inventory_history_group(
                database,
                area_pk=area_pk,
                product_guids=unique_guids,
                play_session_id=snapshot.play_session_id,
                limit=limit,
            )
            if snapshot is not None
            else [{"product_guid": guid, "items": []} for guid in unique_guids]
        )
        return {
            "meta": snapshot_meta(snapshot, stale_after_seconds=app_settings.stale_after_seconds),
            "catalog": _catalog_for_snapshot(database, snapshot),
            "scope": "area_product_group",
            "area_pk": area_pk,
            "product_guids": unique_guids,
            "series": series,
        }

    @app.get("/api/v1/trade/opportunities", tags=["management"], response_model=TradeOpportunitiesResponse)
    def opportunities(database: Database, campaign_id: str | None = None) -> dict:
        inventory = _inventory(database, campaign_id, app_settings)
        effective = resolve_campaign_id(database, campaign_id)
        routes = suggested_routes(database, inventory)
        existing_pairs = {
            (item.source_area_pk, item.destination_area_pk)
            for item in database.scalars(
                select(TradePlan).where(
                    TradePlan.campaign_id == effective,
                    TradePlan.status.in_(["planned", "implemented", "implemented_unverified"]),
                )
            ).all()
        } if effective else set()
        snapshot = latest_complete_snapshot(database, effective)
        _sync_management(
            database,
            effective,
            inventory,
            finance_analysis(database, snapshot),
            routes,
            workforce_latest(database, snapshot),
            route_issues_latest(database, snapshot),
        )
        database.commit()
        return {
            "meta": inventory["meta"],
            "catalog": inventory["catalog"],
            "items": trade_opportunities(inventory),
            "suggested_routes": [item for item in routes if (item["source_area_pk"], item["destination_area_pk"]) not in existing_pairs][:8],
            "notice": "Advisory transfer candidates; route feasibility is unknown.",
        }

    @app.get("/api/v1/trade/routes", tags=["management"], response_model=ActiveTradeRoutesResponse)
    def known_trade_routes(database: Database, campaign_id: str | None = None) -> dict:
        effective = resolve_campaign_id(database, campaign_id)
        snapshot = latest_complete_snapshot(database, effective)
        result = active_trade_routes(
            database,
            effective,
            snapshot,
            stale_after_seconds=app_settings.stale_after_seconds,
        )
        result["meta"] = snapshot_meta(snapshot, stale_after_seconds=app_settings.stale_after_seconds)
        return result

    @app.get("/api/v1/trade/network", tags=["management"], response_model=TradeNetworkResponse)
    def trade_network(database: Database, campaign_id: str | None = None) -> dict:
        effective = resolve_campaign_id(database, campaign_id)
        snapshot = latest_complete_snapshot(database, effective)
        meta = snapshot_meta(snapshot, stale_after_seconds=app_settings.stale_after_seconds)
        route_state = active_trade_routes(
            database,
            effective,
            snapshot,
            stale_after_seconds=app_settings.stale_after_seconds,
        )
        telemetry_active = current_play_session(database, effective) is not None
        sync_trade_plan_runtime(
            database,
            effective,
            route_state,
            telemetry_active=telemetry_active,
            telemetry_stale=bool(meta.get("is_stale", True)),
        )
        database.commit()
        inventory = _inventory(database, effective, app_settings)
        return build_trade_network(
            database, effective, route_state, inventory, meta,
            telemetry_active=telemetry_active,
        )

    @app.get("/api/v1/production/chains", tags=["management"], response_model=ProductionChainsResponse)
    def chains(database: Database, campaign_id: str | None = None) -> dict:
        inventory = _inventory(database, campaign_id, app_settings)
        result = production_chains(database, inventory)
        result["meta"] = inventory["meta"]
        return result

    @app.get("/api/v1/finance", tags=["economy"], response_model=FinanceResponse)
    def finance(database: Database, campaign_id: str | None = None) -> dict:
        snapshot = latest_complete_snapshot(database, resolve_campaign_id(database, campaign_id))
        return {
            "meta": snapshot_meta(snapshot, stale_after_seconds=app_settings.stale_after_seconds),
            "catalog": _catalog_for_snapshot(database, snapshot),
            "finance": finance_latest(database, snapshot),
            "balance_analysis": finance_analysis(database, snapshot),
        }

    @app.get("/api/v1/finance/history", tags=["economy"], response_model=FinanceHistoryResponse)
    def finance_timeline(database: Database, campaign_id: str | None = None, limit: int = Query(default=120, ge=2, le=1000)) -> dict:
        snapshot = latest_complete_snapshot(database, resolve_campaign_id(database, campaign_id))
        return {
            "meta": snapshot_meta(snapshot, stale_after_seconds=app_settings.stale_after_seconds),
            "catalog": _catalog_for_snapshot(database, snapshot),
            "items": finance_history(database, snapshot, limit),
        }

    @app.get("/api/v1/workforce", tags=["economy"])
    def workforce(database: Database, campaign_id: str | None = None) -> dict:
        snapshot = latest_complete_snapshot(database, resolve_campaign_id(database, campaign_id))
        return {
            "meta": snapshot_meta(snapshot, stale_after_seconds=app_settings.stale_after_seconds),
            "catalog": _catalog_for_snapshot(database, snapshot),
            "scope": "current_camera_area",
            "items": workforce_latest(database, snapshot),
        }

    @app.get("/api/v1/policies", tags=["management"])
    def policies(database: Database, campaign_id: str | None = None) -> dict:
        effective = resolve_campaign_id(database, campaign_id)
        if effective is None:
            return {"campaign_id": None, "items": []}
        rows = database.scalars(
            select(AreaProductPolicy)
            .where(AreaProductPolicy.campaign_id == effective)
            .order_by(AreaProductPolicy.area_pk, AreaProductPolicy.product_guid)
        ).all()
        return {"campaign_id": effective, "items": [_policy_dict(row) for row in rows]}

    @app.put("/api/v1/policies", tags=["management"])
    def put_policy(policy: PolicyWrite, database: Database) -> dict:
        area = database.get(Area, policy.area_pk)
        if area is None or area.campaign_id != policy.campaign_id:
            raise HTTPException(status_code=404, detail="area not found in campaign")
        key = (policy.campaign_id, policy.area_pk, policy.product_guid)
        stored = database.get(AreaProductPolicy, key)
        if stored is None:
            stored = AreaProductPolicy(
                campaign_id=policy.campaign_id,
                area_pk=policy.area_pk,
                product_guid=policy.product_guid,
            )
            database.add(stored)
        stored.low_target = policy.low_target
        stored.high_target = policy.high_target
        stored.priority = policy.priority
        stored.excluded = policy.excluded
        stored.updated_at = utcnow()
        database.commit()
        return _policy_dict(stored)

    @app.get("/api/v1/dashboard/overview", tags=["dashboard"], response_model=DashboardOverviewResponse)
    def overview(database: Database, campaign_id: str | None = None) -> dict:
        inventory = _inventory(database, campaign_id, app_settings)
        effective = resolve_campaign_id(database, campaign_id)
        snapshot = latest_complete_snapshot(database, effective)
        workforce_items = workforce_latest(database, snapshot)
        workforce_shortages = [
            item for item in workforce_items
            if item["delta_without_buffs"] is not None and item["delta_without_buffs"] < 0
        ]
        balance = finance_analysis(database, snapshot)
        routes = suggested_routes(database, inventory)
        route_issues = route_issues_latest(database, snapshot)
        action_rows = _sync_management(database, effective, inventory, balance, routes, workforce_items, route_issues)
        database.commit()
        return {
            "meta": inventory["meta"],
            "catalog": inventory["catalog"],
            "finance": finance_latest(database, snapshot),
            "balance_analysis": balance,
            "actions": [action_dict(item) for item in action_rows if item.status in {"active", "accepted"}][:12],
            "suggested_routes": routes[:5],
            "signals": inventory["signals"][:30],
            "transfer_candidates": trade_opportunities(inventory)[:20],
            "route_issues": route_issues,
            "workforce_shortages": workforce_shortages,
            "counts": {
                "inventory_items": len(inventory["items"]),
                "signals": len(inventory["signals"]),
                "transfer_candidates": len(trade_opportunities(inventory)),
            },
            "language": {
                "rate_label": "Net stock change",
                "pressure_label": "Inferred pressure",
            },
        }

    @app.put("/api/v1/settings/active-campaign", tags=["identity"], response_model=ActiveCampaignView)
    def select_campaign(selection: ActiveCampaignWrite, database: Database) -> dict:
        if database.get(Campaign, selection.campaign_id) is None:
            raise HTTPException(status_code=404, detail="campaign not found")
        stored = database.get(CompanionSetting, "active_campaign_id")
        if stored is None:
            stored = CompanionSetting(setting_key="active_campaign_id")
            database.add(stored)
        stored.value_text = selection.campaign_id
        stored.updated_at = utcnow()
        database.commit()
        return {"campaign_id": selection.campaign_id}

    @app.get("/api/v1/actions", tags=["management"], response_model=ActionsResponse)
    def actions(database: Database, campaign_id: str | None = None, include_resolved: bool = False) -> dict:
        effective = resolve_campaign_id(database, campaign_id)
        if effective is None:
            return {"campaign_id": None, "items": []}
        inventory = _inventory(database, effective, app_settings)
        snapshot = latest_complete_snapshot(database, effective)
        workforce_items = workforce_latest(database, snapshot)
        rows = _sync_management(
            database, effective, inventory, finance_analysis(database, snapshot),
            suggested_routes(database, inventory), workforce_items, route_issues_latest(database, snapshot),
        )
        database.commit()
        allowed = rows if include_resolved else [item for item in rows if item.status not in {"resolved", "dismissed", "completed"}]
        return {"campaign_id": effective, "items": [action_dict(item) for item in allowed]}

    @app.patch("/api/v1/actions/{action_id}", tags=["management"], response_model=ActionView)
    def patch_action(action_id: str, patch: ActionPatch, database: Database) -> dict:
        action = database.get(ManagementAction, action_id)
        if action is None:
            raise HTTPException(status_code=404, detail="action not found")
        action.status = patch.status
        action.snoozed_until = utcnow() + timedelta(minutes=patch.snooze_minutes or 60) if patch.status == "snoozed" else None
        action.resolved_at = utcnow() if patch.status in {"completed", "dismissed"} else None
        database.commit()
        return action_dict(action)

    @app.get("/api/v1/trade-plans", tags=["management"], response_model=TradePlansResponse)
    def trade_plans(database: Database, campaign_id: str | None = None) -> dict:
        effective = resolve_campaign_id(database, campaign_id)
        snapshot = latest_complete_snapshot(database, effective)
        meta = snapshot_meta(snapshot, stale_after_seconds=app_settings.stale_after_seconds)
        route_state = active_trade_routes(
            database, effective, snapshot, stale_after_seconds=app_settings.stale_after_seconds,
        )
        sync_trade_plan_runtime(
            database, effective, route_state,
            telemetry_active=current_play_session(database, effective) is not None,
            telemetry_stale=bool(meta.get("is_stale", True)),
        )
        database.commit()
        rows = database.scalars(
            select(TradePlan).where(TradePlan.campaign_id == effective).order_by(TradePlan.updated_at.desc())
        ).all() if effective else []
        return {"campaign_id": effective, "items": [_trade_plan_dict(database, row) for row in rows]}

    @app.post("/api/v1/trade-plans", tags=["management"], response_model=TradePlanView)
    def create_trade_plan(write: TradePlanCreate, database: Database) -> dict:
        effective = resolve_campaign_id(database, write.campaign_id)
        source = database.get(Area, write.source_area_pk)
        destination = database.get(Area, write.destination_area_pk)
        if effective is None or source is None or destination is None or source.campaign_id != effective or destination.campaign_id != effective:
            raise HTTPException(status_code=404, detail="source or destination area not found in campaign")
        if source.area_pk == destination.area_pk:
            raise HTTPException(status_code=422, detail="source and destination must differ")
        plan = TradePlan(
            trade_plan_id=str(uuid.uuid4()), campaign_id=effective,
            source_area_pk=source.area_pk, destination_area_pk=destination.area_pk,
            plan_kind=write.plan_kind,
            usable_ship_capacity=write.usable_ship_capacity,
            expected_round_trip_minutes=write.expected_round_trip_minutes,
            reason=write.reason, evidence_json=json.dumps(write.evidence, ensure_ascii=False, sort_keys=True),
        )
        plan.route_tag, plan.suggested_route_name = new_route_identity(
            database,
            effective,
            source.latest_name or source.area_id_raw,
            destination.latest_name or destination.area_id_raw,
        )
        database.add(plan)
        database.flush()
        database.add_all([
            TradePlanItem(trade_plan_id=plan.trade_plan_id, product_guid=item.product_guid, amount=item.amount)
            for item in write.goods
        ])
        database.commit()
        return _trade_plan_dict(database, plan)

    @app.patch("/api/v1/trade-plans/{trade_plan_id}", tags=["management"], response_model=TradePlanView)
    def patch_trade_plan(trade_plan_id: str, patch: TradePlanPatch, database: Database) -> dict:
        plan = database.get(TradePlan, trade_plan_id)
        if plan is None:
            raise HTTPException(status_code=404, detail="trade plan not found")
        if patch.status is not None:
            plan.status = patch.status
        if patch.plan_kind is not None:
            plan.plan_kind = patch.plan_kind
        if "usable_ship_capacity" in patch.model_fields_set:
            plan.usable_ship_capacity = patch.usable_ship_capacity
        if "expected_round_trip_minutes" in patch.model_fields_set:
            plan.expected_round_trip_minutes = patch.expected_round_trip_minutes
        plan.updated_at = utcnow()
        database.commit()
        return _trade_plan_dict(database, plan)

    @app.post("/api/v1/trade/route-links", tags=["management"], response_model=RouteLinkView)
    def create_route_link(write: RouteLinkWrite, database: Database) -> dict:
        effective = resolve_campaign_id(database, write.campaign_id)
        source, destination = _validate_route_link_endpoints(
            database, effective, write.source_area_pk, write.destination_area_pk, write.trade_plan_id,
        )
        snapshot = latest_complete_snapshot(database, effective)
        route_state = active_trade_routes(
            database, effective, snapshot, stale_after_seconds=app_settings.stale_after_seconds,
        )
        route = next((item for item in route_state["items"] if item["route_key"] == write.route_key), None)
        if route is None:
            raise HTTPException(status_code=404, detail="observed route not found")
        existing = database.scalar(
            select(TradeRouteLink).where(
                TradeRouteLink.campaign_id == effective,
                TradeRouteLink.route_key == write.route_key,
            )
        )
        now = utcnow()
        link = existing or TradeRouteLink(
            link_id=str(uuid.uuid4()),
            campaign_id=effective,
            route_key=write.route_key,
            first_seen_at=now,
            last_seen_at=now,
        )
        link.route_name = route["route_name"]
        link.ship_ids_json = json.dumps(sorted({str(ship["ship_id"]) for ship in route.get("ships") or []}))
        link.trade_plan_id = write.trade_plan_id
        link.source_area_pk = source.area_pk
        link.destination_area_pk = destination.area_pk
        link.link_method = "manual"
        link.updated_at = now
        if existing is None:
            database.add(link)
        database.commit()
        return route_link_dict(database, link)

    @app.patch("/api/v1/trade/route-links/{link_id}", tags=["management"], response_model=RouteLinkView)
    def patch_route_link(link_id: str, patch: RouteLinkPatch, database: Database) -> dict:
        link = database.get(TradeRouteLink, link_id)
        if link is None:
            raise HTTPException(status_code=404, detail="route link not found")
        source_pk = patch.source_area_pk if patch.source_area_pk is not None else link.source_area_pk
        destination_pk = patch.destination_area_pk if patch.destination_area_pk is not None else link.destination_area_pk
        plan_id = patch.trade_plan_id if "trade_plan_id" in patch.model_fields_set else link.trade_plan_id
        source, destination = _validate_route_link_endpoints(
            database, link.campaign_id, source_pk, destination_pk, plan_id,
        )
        if patch.route_key is not None and patch.route_key != link.route_key:
            snapshot = latest_complete_snapshot(database, link.campaign_id)
            route_state = active_trade_routes(
                database, link.campaign_id, snapshot,
                stale_after_seconds=app_settings.stale_after_seconds,
            )
            route = next((item for item in route_state["items"] if item["route_key"] == patch.route_key), None)
            if route is None:
                raise HTTPException(status_code=404, detail="replacement observed route not found")
            conflict = database.scalar(select(TradeRouteLink).where(
                TradeRouteLink.campaign_id == link.campaign_id,
                TradeRouteLink.route_key == patch.route_key,
                TradeRouteLink.link_id != link.link_id,
            ))
            if conflict is not None:
                raise HTTPException(status_code=409, detail="replacement route is already linked")
            link.route_key = patch.route_key
            link.route_name = route["route_name"]
            link.ship_ids_json = json.dumps(sorted({str(ship["ship_id"]) for ship in route.get("ships") or []}))
            link.last_seen_at = utcnow()
        link.source_area_pk = source.area_pk
        link.destination_area_pk = destination.area_pk
        link.trade_plan_id = plan_id
        link.link_method = "manual"
        link.updated_at = utcnow()
        database.commit()
        return route_link_dict(database, link)

    @app.delete("/api/v1/trade/route-links/{link_id}", tags=["management"], status_code=204)
    def delete_route_link(link_id: str, database: Database) -> None:
        link = database.get(TradeRouteLink, link_id)
        if link is None:
            raise HTTPException(status_code=404, detail="route link not found")
        database.delete(link)
        database.commit()

    @app.post("/api/v1/advisor/messages", tags=["advisor"], response_model=AdvisorConversationView)
    def advisor_message(write: AdvisorMessageWrite, database: Database) -> dict:
        effective = resolve_campaign_id(database, write.campaign_id)
        if effective is None:
            raise HTTPException(status_code=404, detail="no campaign selected")
        inventory = _inventory(database, effective, app_settings)
        snapshot = latest_complete_snapshot(database, effective)
        action_rows = _sync_management(
            database, effective, inventory, finance_analysis(database, snapshot), suggested_routes(database, inventory),
            workforce_latest(database, snapshot), route_issues_latest(database, snapshot),
        )
        compact = {
            "observation": inventory["meta"],
            "catalog": inventory["catalog"],
            "finance": finance_analysis(database, snapshot),
            "actions": [
                {"action_id": item.action_id, "kind": item.kind, "severity": item.severity, "title": item.title, "summary": item.summary}
                for item in action_rows if item.status in {"active", "accepted"}
            ][:20],
            "inventory_signals": inventory["signals"][:20],
        }
        try:
            return ask_advisor(
                database, app_settings, campaign_id=effective, question=write.question,
                compact_context=compact, conversation_id=write.conversation_id,
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    @app.get("/api/v1/advisor/conversations/{conversation_id}", tags=["advisor"], response_model=AdvisorConversationView)
    def advisor_conversation(conversation_id: str, database: Database) -> dict:
        conversation = database.get(AdvisorConversation, conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail="conversation not found")
        return conversation_dict(database, conversation)

    @app.delete("/api/v1/advisor/conversations/{conversation_id}", tags=["advisor"], status_code=204)
    def delete_advisor_conversation(conversation_id: str, database: Database) -> None:
        conversation = database.get(AdvisorConversation, conversation_id)
        if conversation is None:
            raise HTTPException(status_code=404, detail="conversation not found")
        messages = database.scalars(select(AdvisorMessage).where(AdvisorMessage.conversation_id == conversation_id)).all()
        for message in messages:
            database.delete(message)
        database.delete(conversation)
        database.commit()

    @app.get("/api/v1/events", tags=["system"])
    async def events(request: Request) -> StreamingResponse:
        async def stream() -> AsyncIterator[str]:
            async for event in broker.subscribe():
                if await request.is_disconnected():
                    break
                name = event.get("event", "message")
                payload = {key: value for key, value in event.items() if key != "event"}
                yield f"event: {name}\ndata: {json.dumps(payload)}\n\n"

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    return app


def _inventory(database: Session, campaign_id: str | None, settings: Settings) -> dict:
    return inventory_latest(
        database,
        campaign_id=campaign_id,
        stale_after_seconds=settings.stale_after_seconds,
        expected_interval_seconds=settings.expected_snapshot_interval_seconds,
    )


def _play_session_dict(play: PlaySession | None) -> dict | None:
    if play is None:
        return None
    return {
        "play_session_id": play.play_session_id,
        "campaign_id": play.campaign_id,
        "load_epoch": play.load_epoch,
        "mod_version": play.mod_version,
        "participant_guid": play.participant_guid,
        "game_seed": play.game_seed,
        "started_at": play.started_at.isoformat(),
        "ended_at": play.ended_at.isoformat() if play.ended_at else None,
        "is_current": play.is_current,
    }


def _catalog_for_snapshot(database: Session, snapshot: SnapshotBatch | None) -> dict:
    play = database.get(PlaySession, snapshot.play_session_id) if snapshot is not None else None
    return catalog_summary(database, play.static_release_id if play else None)


def _area_dict(database: Session, row: Area, *, telemetry_active: bool) -> dict:
    location = database.get(AreaLocation, row.area_pk)
    position = None
    position_source = None
    region_guid = row.confirmed_region_guid
    if location is not None and location.manual_x is not None and location.manual_y is not None:
        position = {"x": location.manual_x, "y": location.manual_y}
        position_source = "manual"
        region_guid = location.manual_region_guid or region_guid
    elif location is not None and location.observed_x is not None and location.observed_y is not None:
        position = {"x": location.observed_x, "y": location.observed_y}
        position_source = "telemetry"
        region_guid = location.observed_region_guid or region_guid
    return {
        "area_pk": row.area_pk,
        "area_id": row.area_id_raw,
        "name": row.latest_name or row.area_id_raw,
        "region_guid": region_guid,
        "game_session_guid": row.confirmed_game_session_guid,
        "region_evidence": row.region_evidence,
        "first_seen_at": row.first_seen_at.isoformat(),
        "last_seen_at": row.last_seen_at.isoformat(),
        "persistent": True,
        "telemetry_active": telemetry_active,
        "position": position,
        "position_source": position_source,
        "location_status": location.observation_status if location else "not_observed",
        "location_error": location.observation_error if location else None,
        "manual_placement": position_source == "manual",
        "latest_observation": {"observed_at": row.last_seen_at.isoformat(), "is_historical": not telemetry_active},
    }


def _sync_management(
    database: Session,
    campaign_id: str | None,
    inventory: dict,
    balance: dict | None,
    routes: list[dict],
    workforce: list[dict],
    route_issues: list[dict],
) -> list[ManagementAction]:
    if campaign_id is None:
        return []
    planned_pairs = {
        (item.source_area_pk, item.destination_area_pk)
        for item in database.scalars(
            select(TradePlan).where(
                TradePlan.campaign_id == campaign_id,
                TradePlan.status.in_(["planned", "implemented", "implemented_unverified"]),
            )
        ).all()
    }
    return sync_actions(
        database,
        campaign_id,
        deterministic_action_specs(
            inventory,
            balance,
            routes,
            workforce,
            route_issues,
            planned_pairs,
            production_chains(database, inventory)["chains"],
        ),
    )


def _trade_plan_dict(database: Session, plan: TradePlan) -> dict:
    source = database.get(Area, plan.source_area_pk)
    destination = database.get(Area, plan.destination_area_pk)
    if plan.route_tag is None or plan.suggested_route_name is None:
        plan.route_tag, plan.suggested_route_name = new_route_identity(
            database,
            plan.campaign_id,
            source.latest_name or source.area_id_raw if source else str(plan.source_area_pk),
            destination.latest_name or destination.area_id_raw if destination else str(plan.destination_area_pk),
        )
        database.flush()
    products = {
        item.product_guid: item.name
        for item in database.scalars(
            select(Product).where(Product.release_id == catalog_summary(database).get("release_id"))
        ).all()
    }
    goods = database.scalars(
        select(TradePlanItem).where(TradePlanItem.trade_plan_id == plan.trade_plan_id)
    ).all()
    total_target = sum(item.amount for item in goods)
    estimated_required_ships = None
    if plan.usable_ship_capacity and plan.expected_round_trip_minutes:
        estimated_required_ships = max(1, math.ceil(total_target / plan.usable_ship_capacity))
    return {
        "trade_plan_id": plan.trade_plan_id,
        "campaign_id": plan.campaign_id,
        "source_area_pk": plan.source_area_pk,
        "source_area_name": source.latest_name or source.area_id_raw if source else str(plan.source_area_pk),
        "destination_area_pk": plan.destination_area_pk,
        "destination_area_name": destination.latest_name or destination.area_id_raw if destination else str(plan.destination_area_pk),
        "status": plan.status,
        "plan_kind": plan.plan_kind,
        "route_tag": plan.route_tag,
        "suggested_route_name": plan.suggested_route_name,
        "usable_ship_capacity": plan.usable_ship_capacity,
        "expected_round_trip_minutes": plan.expected_round_trip_minutes,
        "estimated_required_ships": estimated_required_ships,
        "runtime_status": plan.runtime_status,
        "runtime_freshness": plan.runtime_freshness,
        "goods_verification": plan.goods_verification,
        "last_runtime_match_at": plan.last_runtime_match_at.isoformat() if plan.last_runtime_match_at else None,
        "reason": plan.reason,
        "evidence": json.loads(plan.evidence_json),
        "goods": [{"product_guid": item.product_guid, "product_name": products.get(item.product_guid), "amount": item.amount} for item in goods],
        "created_at": plan.created_at.isoformat(),
        "updated_at": plan.updated_at.isoformat(),
    }


def _validate_route_link_endpoints(
    database: Session,
    campaign_id: str | None,
    source_area_pk: int,
    destination_area_pk: int,
    trade_plan_id: str | None,
) -> tuple[Area, Area]:
    source = database.get(Area, source_area_pk)
    destination = database.get(Area, destination_area_pk)
    if (
        campaign_id is None
        or source is None
        or destination is None
        or source.campaign_id != campaign_id
        or destination.campaign_id != campaign_id
    ):
        raise HTTPException(status_code=404, detail="source or destination area not found in campaign")
    if source.area_pk == destination.area_pk:
        raise HTTPException(status_code=422, detail="source and destination must differ")
    if trade_plan_id is not None:
        plan = database.get(TradePlan, trade_plan_id)
        if plan is None or plan.campaign_id != campaign_id:
            raise HTTPException(status_code=404, detail="trade plan not found in campaign")
        if plan.source_area_pk != source.area_pk or plan.destination_area_pk != destination.area_pk:
            raise HTTPException(status_code=422, detail="route-link endpoints must match the selected trade plan")
    return source, destination


def _reassign_play_session(database: Session, play: PlaySession, target: Campaign) -> None:
    snapshot_ids = database.scalars(
        select(SnapshotBatch.snapshot_id).where(
            SnapshotBatch.play_session_id == play.play_session_id
        )
    ).all()
    if snapshot_ids:
        source_areas = database.scalars(
            select(Area)
            .join(AreaSnapshot, AreaSnapshot.area_pk == Area.area_pk)
            .where(AreaSnapshot.snapshot_id.in_(snapshot_ids))
            .distinct()
        ).all()
        for source in source_areas:
            destination = database.scalar(
                select(Area).where(
                    Area.campaign_id == target.campaign_id,
                    Area.area_id_raw == source.area_id_raw,
                )
            )
            if destination is None:
                destination = Area(
                    campaign_id=target.campaign_id,
                    area_id_raw=source.area_id_raw,
                    latest_name=source.latest_name,
                    first_seen_at=source.first_seen_at,
                    last_seen_at=source.last_seen_at,
                    confirmed_region_guid=source.confirmed_region_guid,
                    confirmed_game_session_guid=source.confirmed_game_session_guid,
                    region_evidence=source.region_evidence,
                )
                database.add(destination)
                database.flush()
            observed_areas = database.scalars(
                select(AreaSnapshot).where(
                    AreaSnapshot.snapshot_id.in_(snapshot_ids),
                    AreaSnapshot.area_pk == source.area_pk,
                )
            ).all()
            for observed_area in observed_areas:
                cloned_area = _clone_observation(
                    observed_area, area_pk=destination.area_pk
                )
                database.add(cloned_area)
                database.flush()
                for model in (
                    AreaProductObservation,
                    AreaPopulationObservation,
                    AreaWorkforceObservation,
                ):
                    originals = database.scalars(
                        select(model).where(
                            model.snapshot_id == observed_area.snapshot_id,
                            model.area_pk == source.area_pk,
                        )
                    ).all()
                    database.add_all(
                        [
                            _clone_observation(item, area_pk=destination.area_pk)
                            for item in originals
                        ]
                    )
                    database.flush()
                    for item in originals:
                        database.delete(item)
                database.flush()
                database.delete(observed_area)
                database.flush()
    play.campaign_id = target.campaign_id
    database.flush()
    refresh_materialized_state(database, target.campaign_id)


def _clone_observation(item, **overrides):  # type: ignore[no-untyped-def]
    values = {column.name: getattr(item, column.name) for column in item.__table__.columns}
    values.update(overrides)
    return type(item)(**values)


def _policy_dict(row: AreaProductPolicy) -> dict:
    return {
        "campaign_id": row.campaign_id,
        "area_pk": row.area_pk,
        "product_guid": row.product_guid,
        "low_target": row.low_target,
        "high_target": row.high_target,
        "priority": row.priority,
        "excluded": row.excluded,
        "updated_at": row.updated_at.isoformat(),
    }


app = create_app()
