from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(UTC)


class StaticRelease(Base):
    __tablename__ = "static_release"

    release_id: Mapped[str] = mapped_column(String, primary_key=True)
    label: Mapped[str] = mapped_column(String, nullable=False)
    game_version: Mapped[str | None] = mapped_column(String)
    source_hash: Mapped[str] = mapped_column(String, nullable=False)
    coverage_note: Mapped[str | None] = mapped_column(Text)
    source_url: Mapped[str | None] = mapped_column(Text)
    source_revision: Mapped[str | None] = mapped_column(String)
    attribution: Mapped[str | None] = mapped_column(Text)
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class Product(Base):
    __tablename__ = "product"

    release_id: Mapped[str] = mapped_column(ForeignKey("static_release.release_id"), primary_key=True)
    product_guid: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    category: Mapped[str | None] = mapped_column(String)
    icon: Mapped[str | None] = mapped_column(String)
    telemetry_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    associated_regions_json: Mapped[str | None] = mapped_column(Text)
    dlc_unlocks_json: Mapped[str | None] = mapped_column(Text)


class BuildingType(Base):
    __tablename__ = "building_type"

    release_id: Mapped[str] = mapped_column(ForeignKey("static_release.release_id"), primary_key=True)
    building_guid: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    icon: Mapped[str | None] = mapped_column(String)
    workforce_guid: Mapped[str | None] = mapped_column(String)
    associated_regions_json: Mapped[str | None] = mapped_column(Text)
    dlc_unlocks_json: Mapped[str | None] = mapped_column(Text)


class BuildingMaintenanceItem(Base):
    __tablename__ = "building_maintenance_item"

    release_id: Mapped[str] = mapped_column(String, primary_key=True)
    building_guid: Mapped[str] = mapped_column(String, primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, primary_key=True)
    resource_guid: Mapped[str] = mapped_column(String, nullable=False)
    amount: Mapped[float] = mapped_column(Float, nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)

    __table_args__ = (
        ForeignKeyConstraint(
            ["release_id", "building_guid"],
            ["building_type.release_id", "building_type.building_guid"],
        ),
    )


class ProductionRecipe(Base):
    __tablename__ = "production_recipe"

    release_id: Mapped[str] = mapped_column(String, primary_key=True)
    recipe_id: Mapped[str] = mapped_column(String, primary_key=True)
    building_guid: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str | None] = mapped_column(String)
    cycle_seconds: Mapped[float | None] = mapped_column(Float)

    __table_args__ = (
        ForeignKeyConstraint(
            ["release_id", "building_guid"],
            ["building_type.release_id", "building_type.building_guid"],
        ),
    )


class ProductionRecipeItem(Base):
    __tablename__ = "production_recipe_item"

    release_id: Mapped[str] = mapped_column(String, primary_key=True)
    recipe_id: Mapped[str] = mapped_column(String, primary_key=True)
    role: Mapped[str] = mapped_column(String, primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, primary_key=True)
    product_guid: Mapped[str] = mapped_column(String, nullable=False)
    amount: Mapped[float] = mapped_column(Float, nullable=False)

    __table_args__ = (
        ForeignKeyConstraint(
            ["release_id", "recipe_id"],
            ["production_recipe.release_id", "production_recipe.recipe_id"],
        ),
        ForeignKeyConstraint(
            ["release_id", "product_guid"],
            ["product.release_id", "product.product_guid"],
        ),
    )


class Campaign(Base):
    __tablename__ = "campaign"

    campaign_id: Mapped[str] = mapped_column(String, primary_key=True)
    display_name: Mapped[str] = mapped_column(String, nullable=False)
    identity_key: Mapped[str | None] = mapped_column(String, unique=True)
    game_seed: Mapped[str | None] = mapped_column(String)
    participant_guid: Mapped[str | None] = mapped_column(String)
    identity_method: Mapped[str] = mapped_column(String, default="heuristic", nullable=False)
    identity_confidence: Mapped[str] = mapped_column(String, default="provisional", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PlaySession(Base):
    __tablename__ = "play_session"

    play_session_id: Mapped[str] = mapped_column(String, primary_key=True)
    campaign_id: Mapped[str | None] = mapped_column(ForeignKey("campaign.campaign_id"))
    static_release_id: Mapped[str] = mapped_column(ForeignKey("static_release.release_id"), nullable=False)
    transport_key: Mapped[str] = mapped_column(String, nullable=False)
    load_epoch: Mapped[int] = mapped_column(Integer, nullable=False)
    mod_version: Mapped[str | None] = mapped_column(String)
    participant_guid: Mapped[str | None] = mapped_column(String)
    game_seed: Mapped[str | None] = mapped_column(String)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    initial_play_time: Mapped[int | None] = mapped_column(Integer)
    last_play_time: Mapped[int | None] = mapped_column(Integer)
    initial_corporation_time: Mapped[int | None] = mapped_column(Integer)
    last_corporation_time: Mapped[int | None] = mapped_column(Integer)
    is_current: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    __table_args__ = (UniqueConstraint("transport_key", "load_epoch", name="uq_play_session_transport_epoch"),)


class Area(Base):
    __tablename__ = "area"

    area_pk: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    campaign_id: Mapped[str] = mapped_column(ForeignKey("campaign.campaign_id"), nullable=False)
    area_id_raw: Mapped[str] = mapped_column(String, nullable=False)
    latest_name: Mapped[str | None] = mapped_column(String)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    confirmed_region_guid: Mapped[str | None] = mapped_column(String)
    confirmed_game_session_guid: Mapped[str | None] = mapped_column(String)
    region_evidence: Mapped[str | None] = mapped_column(String)

    __table_args__ = (UniqueConstraint("campaign_id", "area_id_raw", name="uq_area_campaign_raw"),)


class AreaProductPolicy(Base):
    __tablename__ = "area_product_policy"

    campaign_id: Mapped[str] = mapped_column(ForeignKey("campaign.campaign_id"), primary_key=True)
    area_pk: Mapped[int] = mapped_column(ForeignKey("area.area_pk"), primary_key=True)
    product_guid: Mapped[str] = mapped_column(String, primary_key=True)
    low_target: Mapped[float | None] = mapped_column(Float)
    high_target: Mapped[float | None] = mapped_column(Float)
    priority: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    excluded: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class IngestionCursor(Base):
    __tablename__ = "ingestion_cursor"

    source_path: Mapped[str] = mapped_column(String, primary_key=True)
    source_fingerprint: Mapped[str] = mapped_column(String, nullable=False)
    byte_offset: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    file_size: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)


class TelemetryRaw(Base):
    __tablename__ = "telemetry_raw"

    raw_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    play_session_id: Mapped[str | None] = mapped_column(ForeignKey("play_session.play_session_id"))
    snapshot_id: Mapped[int | None] = mapped_column(ForeignKey("snapshot_batch.snapshot_id"))
    source_path: Mapped[str] = mapped_column(String, nullable=False)
    source_fingerprint: Mapped[str] = mapped_column(String, nullable=False)
    source_offset: Mapped[int] = mapped_column(Integer, nullable=False)
    source_kind: Mapped[str] = mapped_column(String, nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    sequence_no: Mapped[int | None] = mapped_column(Integer)
    load_epoch: Mapped[int | None] = mapped_column(Integer)
    snapshot_sequence: Mapped[int | None] = mapped_column(Integer)
    event_type: Mapped[str] = mapped_column(String, nullable=False)
    schema_version: Mapped[int | None] = mapped_column(Integer)
    mod_version: Mapped[str | None] = mapped_column(String)
    payload_json: Mapped[str] = mapped_column(Text, nullable=False)
    payload_sha256: Mapped[str] = mapped_column(String, nullable=False)
    parse_status: Mapped[str] = mapped_column(String, nullable=False)
    parse_error: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        UniqueConstraint(
            "source_path", "source_fingerprint", "source_offset", name="uq_raw_source_offset"
        ),
        Index("ix_raw_session_sequence", "play_session_id", "sequence_no"),
    )


class SnapshotBatch(Base):
    __tablename__ = "snapshot_batch"

    snapshot_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    play_session_id: Mapped[str] = mapped_column(ForeignKey("play_session.play_session_id"), nullable=False)
    snapshot_sequence: Mapped[int] = mapped_column(Integer, nullable=False)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    play_time: Mapped[int | None] = mapped_column(Integer)
    corporation_time: Mapped[int | None] = mapped_column(Integer)
    current_game_session_guid: Mapped[str | None] = mapped_column(String)
    current_region_guid: Mapped[str | None] = mapped_column(String)
    current_area_id_raw: Mapped[str | None] = mapped_column(String)
    participant_guid: Mapped[str | None] = mapped_column(String)
    area_enumeration_scope: Mapped[str] = mapped_column(String, default="unknown", nullable=False)
    expected_area_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    emitted_area_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    is_complete: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    normalization_status: Mapped[str] = mapped_column(String, default="assembling", nullable=False)
    section_mode: Mapped[str] = mapped_column(String, default="full", nullable=False)
    catalog_hash: Mapped[str | None] = mapped_column(String)

    __table_args__ = (
        UniqueConstraint("play_session_id", "snapshot_sequence", name="uq_snapshot_session_sequence"),
        Index("ix_snapshot_current", "play_session_id", "is_complete", "snapshot_sequence"),
    )


class SnapshotSectionStatus(Base):
    __tablename__ = "snapshot_section_status"

    status_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    snapshot_id: Mapped[int] = mapped_column(ForeignKey("snapshot_batch.snapshot_id"), nullable=False)
    section_name: Mapped[str] = mapped_column(String, nullable=False)
    area_id_raw: Mapped[str | None] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, nullable=False)
    reported_count: Mapped[int | None] = mapped_column(Integer)
    captured_count: Mapped[int | None] = mapped_column(Integer)
    truncated: Mapped[bool | None] = mapped_column(Boolean)
    error_json: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        UniqueConstraint("snapshot_id", "section_name", "area_id_raw", name="uq_section_snapshot_scope"),
    )


class AreaSnapshot(Base):
    __tablename__ = "area_snapshot"

    snapshot_id: Mapped[int] = mapped_column(ForeignKey("snapshot_batch.snapshot_id"), primary_key=True)
    area_pk: Mapped[int] = mapped_column(ForeignKey("area.area_pk"), primary_key=True)
    observed_name: Mapped[str | None] = mapped_column(String)
    owner_participant_guid: Mapped[str | None] = mapped_column(String)
    owner_name: Mapped[str | None] = mapped_column(String)
    owned_by_current_player: Mapped[bool | None] = mapped_column(Boolean)
    has_area_economy: Mapped[bool | None] = mapped_column(Boolean)
    population_total: Mapped[float | None] = mapped_column(Float)
    residence_count: Mapped[float | None] = mapped_column(Float)
    city_status_raw: Mapped[str | None] = mapped_column(String)
    area_balance: Mapped[float | None] = mapped_column(Float)
    land_tax: Mapped[float | None] = mapped_column(Float)


class AreaProductObservation(Base):
    __tablename__ = "area_product_observation"

    snapshot_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    area_pk: Mapped[int] = mapped_column(Integer, primary_key=True)
    product_guid: Mapped[str] = mapped_column(String, primary_key=True)
    stock: Mapped[float | None] = mapped_column(Float)
    available_stock: Mapped[float | None] = mapped_column(Float)
    storage_capacity: Mapped[float | None] = mapped_column(Float)
    reserved_amount: Mapped[float | None] = mapped_column(Float)
    free_space_raw: Mapped[float | None] = mapped_column(Float)
    engine_trend_raw: Mapped[float | None] = mapped_column(Float)
    passive_trade_minimum: Mapped[float | None] = mapped_column(Float)
    offer_is_no_offer: Mapped[bool | None] = mapped_column(Boolean)
    offer_is_buy_only: Mapped[bool | None] = mapped_column(Boolean)
    offer_is_sell_only: Mapped[bool | None] = mapped_column(Boolean)
    offer_is_buy_or_sell: Mapped[bool | None] = mapped_column(Boolean)
    offer_is_preferred_good: Mapped[bool | None] = mapped_column(Boolean)

    __table_args__ = (
        ForeignKeyConstraint(
            ["snapshot_id", "area_pk"],
            ["area_snapshot.snapshot_id", "area_snapshot.area_pk"],
        ),
        Index("ix_product_observation_lookup", "area_pk", "product_guid", "snapshot_id"),
    )


class AreaPopulationObservation(Base):
    __tablename__ = "area_population_observation"

    snapshot_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    area_pk: Mapped[int] = mapped_column(Integer, primary_key=True)
    population_guid: Mapped[str] = mapped_column(String, primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    localized_name: Mapped[str | None] = mapped_column(String)
    population_count: Mapped[float | None] = mapped_column(Float)
    satisfaction: Mapped[float | None] = mapped_column(Float)

    __table_args__ = (
        ForeignKeyConstraint(
            ["snapshot_id", "area_pk"],
            ["area_snapshot.snapshot_id", "area_snapshot.area_pk"],
        ),
    )


class ParticipantFinanceObservation(Base):
    __tablename__ = "participant_finance_observation"

    snapshot_id: Mapped[int] = mapped_column(ForeignKey("snapshot_batch.snapshot_id"), primary_key=True)
    participant_guid: Mapped[str] = mapped_column(String, primary_key=True)
    treasury: Mapped[float | None] = mapped_column(Float)
    total_balance_raw: Mapped[float | None] = mapped_column(Float)
    trade_balance_period_raw: Mapped[float | None] = mapped_column(Float)
    passive_trade_balance_period_raw: Mapped[float | None] = mapped_column(Float)
    active_trade_balance_period_raw: Mapped[float | None] = mapped_column(Float)


class FinanceCategoryObservation(Base):
    __tablename__ = "finance_category_observation"

    snapshot_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    participant_guid: Mapped[str] = mapped_column(String, primary_key=True)
    kind: Mapped[str] = mapped_column(String, primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, primary_key=True)
    category_guid_raw: Mapped[str | None] = mapped_column(String)
    localized_label: Mapped[str | None] = mapped_column(String)
    value: Mapped[float | None] = mapped_column(Float)

    __table_args__ = (
        ForeignKeyConstraint(
            ["snapshot_id", "participant_guid"],
            ["participant_finance_observation.snapshot_id", "participant_finance_observation.participant_guid"],
        ),
    )


class AreaWorkforceObservation(Base):
    __tablename__ = "area_workforce_observation"

    snapshot_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    area_pk: Mapped[int] = mapped_column(Integer, primary_key=True)
    workforce_guid: Mapped[str] = mapped_column(String, primary_key=True)
    scope_kind: Mapped[str] = mapped_column(String, default="current_camera_area", nullable=False)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    localized_name: Mapped[str | None] = mapped_column(String)
    population_count: Mapped[float | None] = mapped_column(Float)
    resulting_from_population: Mapped[float | None] = mapped_column(Float)
    registered_production: Mapped[float | None] = mapped_column(Float)
    registered_consumption: Mapped[float | None] = mapped_column(Float)
    delta_without_buffs: Mapped[float | None] = mapped_column(Float)
    delta_with_buffs: Mapped[float | None] = mapped_column(Float)

    __table_args__ = (
        ForeignKeyConstraint(
            ["snapshot_id", "area_pk"],
            ["area_snapshot.snapshot_id", "area_snapshot.area_pk"],
        ),
    )


class TradeRouteIssueObservation(Base):
    __tablename__ = "trade_route_issue_observation"

    snapshot_id: Mapped[int] = mapped_column(ForeignKey("snapshot_batch.snapshot_id"), primary_key=True)
    ordinal: Mapped[int] = mapped_column(Integer, primary_key=True)
    route_name: Mapped[str | None] = mapped_column(String)
    issue_code: Mapped[str] = mapped_column(String, primary_key=True)
    severity: Mapped[str] = mapped_column(String, nullable=False)
    active_error_count: Mapped[int | None] = mapped_column(Integer)
    raw_flags_json: Mapped[str | None] = mapped_column(Text)


class AreaLocation(Base):
    __tablename__ = "area_location"

    area_pk: Mapped[int] = mapped_column(ForeignKey("area.area_pk"), primary_key=True)
    observed_x: Mapped[float | None] = mapped_column(Float)
    observed_y: Mapped[float | None] = mapped_column(Float)
    observed_session_guid: Mapped[str | None] = mapped_column(String)
    observed_region_guid: Mapped[str | None] = mapped_column(String)
    kontor_id_raw: Mapped[str | None] = mapped_column(String)
    observation_status: Mapped[str] = mapped_column(String, default="not_observed", nullable=False)
    observation_error: Mapped[str | None] = mapped_column(Text)
    observed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    manual_region_guid: Mapped[str | None] = mapped_column(String)
    manual_x: Mapped[float | None] = mapped_column(Float)
    manual_y: Mapped[float | None] = mapped_column(Float)
    manual_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AreaProductCurrent(Base):
    __tablename__ = "area_product_current"

    area_pk: Mapped[int] = mapped_column(ForeignKey("area.area_pk"), primary_key=True)
    product_guid: Mapped[str] = mapped_column(String, primary_key=True)
    campaign_id: Mapped[str] = mapped_column(ForeignKey("campaign.campaign_id"), nullable=False)
    play_session_id: Mapped[str] = mapped_column(ForeignKey("play_session.play_session_id"), nullable=False)
    snapshot_id: Mapped[int] = mapped_column(ForeignKey("snapshot_batch.snapshot_id"), nullable=False)
    stock: Mapped[float | None] = mapped_column(Float)
    available_stock: Mapped[float | None] = mapped_column(Float)
    storage_capacity: Mapped[float | None] = mapped_column(Float)
    reserved_amount: Mapped[float | None] = mapped_column(Float)
    free_space_raw: Mapped[float | None] = mapped_column(Float)
    engine_trend_raw: Mapped[float | None] = mapped_column(Float)
    passive_trade_minimum: Mapped[float | None] = mapped_column(Float)
    offer_is_no_offer: Mapped[bool | None] = mapped_column(Boolean)
    offer_is_buy_only: Mapped[bool | None] = mapped_column(Boolean)
    offer_is_sell_only: Mapped[bool | None] = mapped_column(Boolean)
    offer_is_buy_or_sell: Mapped[bool | None] = mapped_column(Boolean)
    offer_is_preferred_good: Mapped[bool | None] = mapped_column(Boolean)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_attempt_snapshot_id: Mapped[int | None] = mapped_column(Integer)
    section_status: Mapped[str] = mapped_column(String, default="success", nullable=False)

    __table_args__ = (Index("ix_product_current_campaign", "campaign_id", "area_pk"),)


class AreaBuildingObservation(Base):
    __tablename__ = "area_building_observation"

    snapshot_id: Mapped[int] = mapped_column(ForeignKey("snapshot_batch.snapshot_id"), primary_key=True)
    area_pk: Mapped[int] = mapped_column(ForeignKey("area.area_pk"), primary_key=True)
    building_guid: Mapped[str] = mapped_column(String, primary_key=True)
    building_count: Mapped[int] = mapped_column(Integer, nullable=False)


class AreaBuildingCurrent(Base):
    __tablename__ = "area_building_current"

    area_pk: Mapped[int] = mapped_column(ForeignKey("area.area_pk"), primary_key=True)
    building_guid: Mapped[str] = mapped_column(String, primary_key=True)
    campaign_id: Mapped[str] = mapped_column(ForeignKey("campaign.campaign_id"), nullable=False)
    play_session_id: Mapped[str] = mapped_column(ForeignKey("play_session.play_session_id"), nullable=False)
    snapshot_id: Mapped[int] = mapped_column(ForeignKey("snapshot_batch.snapshot_id"), nullable=False)
    building_count: Mapped[int | None] = mapped_column(Integer)
    presence_status: Mapped[str] = mapped_column(String, default="unknown", nullable=False)
    observed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_attempt_snapshot_id: Mapped[int | None] = mapped_column(Integer)

    __table_args__ = (Index("ix_building_current_campaign", "campaign_id", "area_pk"),)


class CompanionSetting(Base):
    __tablename__ = "companion_setting"

    setting_key: Mapped[str] = mapped_column(String, primary_key=True)
    value_text: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class ManagementAction(Base):
    __tablename__ = "management_action"

    action_id: Mapped[str] = mapped_column(String, primary_key=True)
    campaign_id: Mapped[str] = mapped_column(ForeignKey("campaign.campaign_id"), nullable=False)
    kind: Mapped[str] = mapped_column(String, nullable=False)
    severity: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    evidence_json: Mapped[str] = mapped_column(Text, nullable=False)
    deep_link: Mapped[str | None] = mapped_column(String)
    status: Mapped[str] = mapped_column(String, default="active", nullable=False)
    snoozed_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (Index("ix_action_campaign_status", "campaign_id", "status"),)


class TradePlan(Base):
    __tablename__ = "trade_plan"

    trade_plan_id: Mapped[str] = mapped_column(String, primary_key=True)
    campaign_id: Mapped[str] = mapped_column(ForeignKey("campaign.campaign_id"), nullable=False)
    source_area_pk: Mapped[int] = mapped_column(ForeignKey("area.area_pk"), nullable=False)
    destination_area_pk: Mapped[int] = mapped_column(ForeignKey("area.area_pk"), nullable=False)
    status: Mapped[str] = mapped_column(String, default="planned", nullable=False)
    reason: Mapped[str | None] = mapped_column(Text)
    evidence_json: Mapped[str] = mapped_column(Text, default="{}", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class TradePlanItem(Base):
    __tablename__ = "trade_plan_item"

    trade_plan_id: Mapped[str] = mapped_column(ForeignKey("trade_plan.trade_plan_id"), primary_key=True)
    product_guid: Mapped[str] = mapped_column(String, primary_key=True)
    amount: Mapped[float] = mapped_column(Float, nullable=False)


class AdvisorConversation(Base):
    __tablename__ = "advisor_conversation"

    conversation_id: Mapped[str] = mapped_column(String, primary_key=True)
    campaign_id: Mapped[str] = mapped_column(ForeignKey("campaign.campaign_id"), nullable=False)
    title: Mapped[str | None] = mapped_column(String)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class AdvisorMessage(Base):
    __tablename__ = "advisor_message"

    message_id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("advisor_conversation.conversation_id", ondelete="CASCADE"), nullable=False)
    role: Mapped[str] = mapped_column(String, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    action_ids_json: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    __table_args__ = (Index("ix_advisor_message_conversation", "conversation_id", "message_id"),)
