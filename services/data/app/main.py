from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Iterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from .analytics import (
    current_play_session,
    finance_latest,
    inventory_history,
    inventory_latest,
    latest_complete_snapshot,
    production_chains,
    route_issues_latest,
    snapshot_meta,
    trade_opportunities,
    workforce_latest,
)
from .catalog import catalog_summary, load_catalog
from .config import Settings, settings as default_settings
from .db import Base, SessionLocal, engine
from .ingestion import TelemetryTailer
from .models import (
    Area,
    AreaPopulationObservation,
    AreaProductObservation,
    AreaProductPolicy,
    AreaSnapshot,
    AreaWorkforceObservation,
    Campaign,
    IngestionCursor,
    PlaySession,
    Product,
    SnapshotBatch,
    TelemetryRaw,
    utcnow,
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
        version="1.0.0",
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
            "latest_snapshot": snapshot_meta(
                snapshot, stale_after_seconds=app_settings.stale_after_seconds
            ),
            "catalog": catalog_summary(database, play.static_release_id if play else None),
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

    @app.get("/api/v1/areas", tags=["economy"])
    def areas(database: Database, campaign_id: str | None = None) -> dict:
        play = current_play_session(database, campaign_id)
        effective_campaign = campaign_id or (play.campaign_id if play else None)
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
                {
                    "area_pk": row.area_pk,
                    "area_id": row.area_id_raw,
                    "name": row.latest_name or row.area_id_raw,
                    "region_guid": row.confirmed_region_guid,
                    "game_session_guid": row.confirmed_game_session_guid,
                    "region_evidence": row.region_evidence,
                    "first_seen_at": row.first_seen_at.isoformat(),
                    "last_seen_at": row.last_seen_at.isoformat(),
                }
                for row in rows
            ],
        }

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

    @app.get("/api/v1/trade/opportunities", tags=["management"])
    def opportunities(database: Database, campaign_id: str | None = None) -> dict:
        inventory = _inventory(database, campaign_id, app_settings)
        return {
            "meta": inventory["meta"],
            "catalog": inventory["catalog"],
            "items": trade_opportunities(inventory),
            "notice": "Advisory transfer candidates; route feasibility is unknown.",
        }

    @app.get("/api/v1/production/chains", tags=["management"])
    def chains(database: Database, campaign_id: str | None = None) -> dict:
        inventory = _inventory(database, campaign_id, app_settings)
        result = production_chains(database, inventory)
        result["meta"] = inventory["meta"]
        return result

    @app.get("/api/v1/finance", tags=["economy"])
    def finance(database: Database, campaign_id: str | None = None) -> dict:
        snapshot = latest_complete_snapshot(database, campaign_id)
        return {
            "meta": snapshot_meta(snapshot, stale_after_seconds=app_settings.stale_after_seconds),
            "catalog": _catalog_for_snapshot(database, snapshot),
            "finance": finance_latest(database, snapshot),
        }

    @app.get("/api/v1/workforce", tags=["economy"])
    def workforce(database: Database, campaign_id: str | None = None) -> dict:
        snapshot = latest_complete_snapshot(database, campaign_id)
        return {
            "meta": snapshot_meta(snapshot, stale_after_seconds=app_settings.stale_after_seconds),
            "catalog": _catalog_for_snapshot(database, snapshot),
            "scope": "current_camera_area",
            "items": workforce_latest(database, snapshot),
        }

    @app.get("/api/v1/policies", tags=["management"])
    def policies(database: Database, campaign_id: str | None = None) -> dict:
        play = current_play_session(database, campaign_id)
        effective = campaign_id or (play.campaign_id if play else None)
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

    @app.get("/api/v1/dashboard/overview", tags=["dashboard"])
    def overview(database: Database, campaign_id: str | None = None) -> dict:
        inventory = _inventory(database, campaign_id, app_settings)
        snapshot = latest_complete_snapshot(database, campaign_id)
        workforce_items = workforce_latest(database, snapshot)
        workforce_shortages = [
            item for item in workforce_items
            if item["delta_without_buffs"] is not None and item["delta_without_buffs"] < 0
        ]
        return {
            "meta": inventory["meta"],
            "catalog": inventory["catalog"],
            "finance": finance_latest(database, snapshot),
            "signals": inventory["signals"][:30],
            "transfer_candidates": trade_opportunities(inventory)[:20],
            "route_issues": route_issues_latest(database, snapshot),
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
