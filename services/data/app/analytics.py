from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime
import json
from statistics import median
from typing import Any
import hashlib

from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from .catalog import catalog_summary
from .models import (
    Area,
    ActiveTradeRouteCurrent,
    ActiveTradeRouteShipCurrent,
    AreaBuildingCurrent,
    AreaProductCurrent,
    AreaProductObservation,
    AreaProductPolicy,
    AreaSnapshot,
    AreaWorkforceObservation,
    BuildingType,
    BuildingMaintenanceItem,
    CompanionSetting,
    FinanceCategoryObservation,
    ParticipantFinanceObservation,
    PlaySession,
    Product,
    ProductionRecipe,
    ProductionRecipeItem,
    SnapshotBatch,
    SnapshotSectionStatus,
    TradeRouteIssueObservation,
)


WORKFORCE_NAMES = {
    "2181": "Libertus Workforce",
    "2184": "Plebeian Workforce",
    "2185": "Equites Workforce",
    "2186": "Patrician Workforce",
    "2192": "Wader Workforce",
    "2196": "Smith Workforce",
    "2198": "Mercators Workforce",
    "2199": "Nobles Workforce",
}


def workforce_name(workforce_guid: str | None) -> str | None:
    if workforce_guid is None:
        return None
    return WORKFORCE_NAMES.get(workforce_guid, f"Workforce {workforce_guid}")


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.isoformat()


def current_play_session(session: Session, campaign_id: str | None = None) -> PlaySession | None:
    query = select(PlaySession).where(PlaySession.is_current.is_(True))
    if campaign_id:
        query = query.where(PlaySession.campaign_id == campaign_id)
    return session.scalar(query.order_by(PlaySession.started_at.desc()))


def resolve_campaign_id(session: Session, explicit: str | None = None) -> str | None:
    if explicit:
        return explicit
    selected = session.get(CompanionSetting, "active_campaign_id")
    if selected is not None and selected.value_text:
        return selected.value_text
    active = current_play_session(session)
    if active is not None and active.campaign_id:
        return active.campaign_id
    return session.scalar(
        select(PlaySession.campaign_id)
        .join(SnapshotBatch, SnapshotBatch.play_session_id == PlaySession.play_session_id)
        .where(SnapshotBatch.is_complete.is_(True), PlaySession.campaign_id.is_not(None))
        .order_by(SnapshotBatch.completed_at.desc(), SnapshotBatch.received_at.desc())
    )


def latest_complete_snapshot(session: Session, campaign_id: str | None = None) -> SnapshotBatch | None:
    query = select(SnapshotBatch).join(PlaySession).where(SnapshotBatch.is_complete.is_(True))
    if campaign_id:
        query = query.where(PlaySession.campaign_id == campaign_id)
    else:
        active = current_play_session(session)
        if active is not None:
            query = query.where(PlaySession.play_session_id == active.play_session_id)
    return session.scalar(
        query.order_by(
            SnapshotBatch.completed_at.desc(),
            SnapshotBatch.received_at.desc(),
            SnapshotBatch.snapshot_sequence.desc(),
        )
    )


def snapshot_meta(snapshot: SnapshotBatch | None, *, stale_after_seconds: int) -> dict:
    if snapshot is None:
        return {
            "snapshot_id": None,
            "play_session_id": None,
            "observed_at": None,
            "scope": None,
            "freshness_seconds": None,
            "is_stale": True,
        }
    received_at = snapshot.completed_at or snapshot.received_at
    if received_at.tzinfo is None:
        received_at = received_at.replace(tzinfo=UTC)
    freshness = max(0.0, (datetime.now(UTC) - received_at).total_seconds())
    return {
        "snapshot_id": snapshot.snapshot_id,
        "play_session_id": snapshot.play_session_id,
        "observed_at": _iso(received_at),
        "scope": snapshot.area_enumeration_scope,
        "freshness_seconds": round(freshness, 1),
        "is_stale": freshness > stale_after_seconds,
    }


def _offer_mode(item: AreaProductObservation) -> str:
    if item.offer_is_no_offer is True:
        return "none"
    if item.offer_is_buy_only is True:
        return "buy"
    if item.offer_is_sell_only is True:
        return "sell"
    if item.offer_is_buy_or_sell is True:
        return "buy_or_sell"
    return "unknown"


def _session_stock_samples(
    session: Session,
    play_session_id: str,
    *,
    through_snapshot_sequence: int | None = None,
    area_pk: int | None = None,
    product_guids: list[str] | None = None,
) -> dict[tuple[int, str], list[dict[str, Any]]]:
    snapshot_query = (
        select(SnapshotBatch)
        .where(
            SnapshotBatch.play_session_id == play_session_id,
            SnapshotBatch.is_complete.is_(True),
        )
        .order_by(SnapshotBatch.snapshot_sequence)
    )
    if through_snapshot_sequence is not None:
        snapshot_query = snapshot_query.where(
            SnapshotBatch.snapshot_sequence <= through_snapshot_sequence
        )
    snapshots = session.scalars(snapshot_query).all()
    if not snapshots:
        return {}
    snapshot_ids = [item.snapshot_id for item in snapshots]

    observation_query = select(AreaProductObservation).where(
        AreaProductObservation.snapshot_id.in_(snapshot_ids)
    )
    if area_pk is not None:
        observation_query = observation_query.where(AreaProductObservation.area_pk == area_pk)
    if product_guids is not None:
        observation_query = observation_query.where(
            AreaProductObservation.product_guid.in_(product_guids)
        )
    observations = session.scalars(observation_query).all()
    changes: dict[int, dict[tuple[int, str], AreaProductObservation]] = defaultdict(dict)
    for item in observations:
        changes[item.snapshot_id][(item.area_pk, item.product_guid)] = item

    area_query = (
        select(AreaSnapshot.snapshot_id, AreaSnapshot.area_pk, Area.area_id_raw)
        .join(Area, Area.area_pk == AreaSnapshot.area_pk)
        .where(
            AreaSnapshot.snapshot_id.in_(snapshot_ids),
        )
    )
    if area_pk is not None:
        area_query = area_query.where(AreaSnapshot.area_pk == area_pk)
    areas_by_snapshot: dict[int, dict[int, str]] = defaultdict(dict)
    for snapshot_id, observed_area_pk, area_id_raw in session.execute(area_query):
        areas_by_snapshot[snapshot_id][observed_area_pk] = area_id_raw

    section_rows = session.execute(
        select(
            SnapshotSectionStatus.snapshot_id,
            SnapshotSectionStatus.area_id_raw,
            SnapshotSectionStatus.status,
        ).where(
            SnapshotSectionStatus.snapshot_id.in_(snapshot_ids),
            SnapshotSectionStatus.section_name == "inventory",
        )
    ).all()
    inventory_status = {
        (snapshot_id, raw_area_id): status
        for snapshot_id, raw_area_id, status in section_rows
    }

    current: dict[tuple[int, str], AreaProductObservation] = {}
    samples: dict[tuple[int, str], list[dict[str, Any]]] = defaultdict(list)
    for snapshot in snapshots:
        snapshot_changes = changes.get(snapshot.snapshot_id, {})
        current.update(snapshot_changes)
        changed_areas = {key[0] for key in snapshot_changes}
        valid_areas: set[int] = set()
        for observed_area_pk, raw_area_id in areas_by_snapshot.get(snapshot.snapshot_id, {}).items():
            status = inventory_status.get((snapshot.snapshot_id, raw_area_id))
            if status == "success" or (status is None and observed_area_pk in changed_areas):
                valid_areas.add(observed_area_pk)
        for key, value in current.items():
            if key[0] not in valid_areas:
                continue
            samples[key].append(
                {
                    "snapshot": snapshot,
                    "stock": value.stock,
                    "available_stock": value.available_stock,
                    "capacity": value.storage_capacity,
                    "sample_kind": "observed" if key in snapshot_changes else "carried_forward",
                    "source_snapshot_id": value.snapshot_id,
                }
            )
    return samples


def _session_velocity_map(
    session: Session,
    play_session_id: str,
    expected_interval_seconds: int,
    *,
    through_snapshot_sequence: int | None = None,
) -> dict[tuple[int, str], dict]:
    samples = _session_stock_samples(
        session,
        play_session_id,
        through_snapshot_sequence=through_snapshot_sequence,
    )
    points: dict[tuple[int, str], list[tuple[int, float]]] = defaultdict(list)
    for key, values_for_key in samples.items():
        for sample in values_for_key:
            stock = sample["stock"]
            play_time = sample["snapshot"].play_time
            if stock is None or play_time is None:
                continue
            values = points[key]
            point = (play_time, stock)
            if values and play_time < values[-1][0]:
                # A game-clock rollback starts a new derivative segment. Never
                # compare post-load/rollback stock with the abandoned timeline.
                points[key] = [point]
            elif values and play_time == values[-1][0]:
                # A paused duplicate carries no game-time interval. Retain the
                # most recent observation at that clock value without a slope.
                values[-1] = point
            else:
                values.append(point)

    result: dict[tuple[int, str], dict] = {}
    max_gap_ms = expected_interval_seconds * 2 * 1000
    for key, values in points.items():
        if not values:
            continue
        window_start = values[-1][0] - 300_000
        values = [point for point in values if point[0] >= window_start]
        slopes: list[float] = []
        for previous, current in zip(values, values[1:]):
            elapsed_ms = current[0] - previous[0]
            if 0 < elapsed_ms <= max_gap_ms:
                slopes.append((current[1] - previous[1]) / (elapsed_ms / 60_000))
        if slopes:
            value = median(slopes)
            result[key] = {
                "net_stock_change_per_minute": round(value, 3),
                "interval_count": len(slopes),
                "window_minutes": 5,
                "confidence": "stable" if len(slopes) >= 3 else "provisional",
                "source_play_session_id": play_session_id,
                "is_historical": False,
            }
    return result


def _velocity_map(
    session: Session,
    snapshot: SnapshotBatch,
    expected_interval_seconds: int,
) -> dict[tuple[int, str], dict]:
    if snapshot.play_time is None:
        return {}
    result = _session_velocity_map(
        session,
        snapshot.play_session_id,
        expected_interval_seconds,
        through_snapshot_sequence=snapshot.snapshot_sequence,
    )
    play = session.get(PlaySession, snapshot.play_session_id)
    if play is None or play.campaign_id is None:
        return result
    target_keys = set(
        session.execute(
            select(AreaProductCurrent.area_pk, AreaProductCurrent.product_guid).where(
                AreaProductCurrent.campaign_id == play.campaign_id
            )
        ).all()
    )
    missing_keys = target_keys - result.keys()
    if not missing_keys:
        return result

    # A new load deliberately starts a new derivative boundary. Until its
    # first valid interval arrives, keep the most recent older rate visible as
    # explicitly historical context instead of presenting an empty dashboard.
    previous_sessions = session.scalars(
        select(PlaySession)
        .where(
            PlaySession.campaign_id == play.campaign_id,
            PlaySession.play_session_id != play.play_session_id,
            PlaySession.started_at <= play.started_at,
        )
        .order_by(PlaySession.started_at.desc())
    ).all()
    for previous in previous_sessions:
        previous_rates = _session_velocity_map(
            session, previous.play_session_id, expected_interval_seconds
        )
        for key, rate in previous_rates.items():
            if key not in missing_keys:
                continue
            result[key] = {
                **rate,
                "confidence": "previous_session",
                "source_confidence": rate["confidence"],
                "is_historical": True,
            }
            missing_keys.remove(key)
        if not missing_keys:
            break
    return result


def inventory_latest(
    session: Session,
    *,
    campaign_id: str | None,
    stale_after_seconds: int,
    expected_interval_seconds: int,
) -> dict:
    campaign_id = resolve_campaign_id(session, campaign_id)
    snapshot = latest_complete_snapshot(session, campaign_id)
    meta = snapshot_meta(snapshot, stale_after_seconds=stale_after_seconds)
    release_id = None
    if snapshot is not None:
        play = session.get(PlaySession, snapshot.play_session_id)
        release_id = play.static_release_id if play else None
    coverage = catalog_summary(session, release_id)
    if snapshot is None:
        return {"meta": meta, "catalog": coverage, "items": [], "signals": []}

    velocity = _velocity_map(session, snapshot, expected_interval_seconds)
    active_play = current_play_session(session, campaign_id)
    if active_play is not None and active_play.play_session_id != snapshot.play_session_id:
        velocity = {
            key: {
                **rate,
                "confidence": "previous_session",
                "source_confidence": rate.get("source_confidence", rate["confidence"]),
                "is_historical": True,
            }
            for key, rate in velocity.items()
        }
    rows = session.execute(
        select(AreaProductCurrent, Area, Product, AreaProductPolicy)
        .join(Area, Area.area_pk == AreaProductCurrent.area_pk)
        .outerjoin(
            Product,
            and_(
                Product.release_id == release_id,
                Product.product_guid == AreaProductCurrent.product_guid,
            ),
        )
        .outerjoin(
            AreaProductPolicy,
            and_(
                AreaProductPolicy.campaign_id == Area.campaign_id,
                AreaProductPolicy.area_pk == Area.area_pk,
                AreaProductPolicy.product_guid == AreaProductCurrent.product_guid,
            ),
        )
        .where(AreaProductCurrent.campaign_id == campaign_id)
        .order_by(Area.latest_name, Product.name)
    ).all()

    items: list[dict[str, Any]] = []
    signals: list[dict[str, Any]] = []
    for observed, area, product, policy in rows:
        capacity = observed.storage_capacity
        available = observed.available_stock if observed.available_stock is not None else observed.stock
        passive_min = observed.passive_trade_minimum
        low_target = (
            policy.low_target
            if policy is not None and policy.low_target is not None
            else passive_min if passive_min is not None and passive_min > 0
            else capacity * 0.25 if capacity is not None
            else None
        )
        high_target = (
            policy.high_target
            if policy is not None and policy.high_target is not None
            else capacity * 0.8 if capacity is not None
            else None
        )
        if low_target is not None and high_target is not None and high_target < low_target:
            high_target = low_target
        fill = observed.stock / capacity if observed.stock is not None and capacity and capacity > 0 else None
        rate = velocity.get((area.area_pk, observed.product_guid))
        current_rate = rate if rate and not rate.get("is_historical", False) else None
        eta = None
        if current_rate and available is not None and current_rate["net_stock_change_per_minute"] < 0:
            eta = available / abs(current_rate["net_stock_change_per_minute"])
        item = {
            "area_pk": area.area_pk,
            "area_id": area.area_id_raw,
            "area_name": area.latest_name or area.area_id_raw,
            "region_guid": area.confirmed_region_guid,
            "product_guid": observed.product_guid,
            "product_name": product.name if product else f"Product {observed.product_guid}",
            "category": product.category if product else None,
            "stock": observed.stock,
            "available_stock": observed.available_stock,
            "capacity": capacity,
            "reserved": observed.reserved_amount,
            "fill_ratio": round(fill, 4) if fill is not None else None,
            "free_space_raw": observed.free_space_raw,
            "engine_trend_raw": observed.engine_trend_raw,
            "passive_trade_minimum": passive_min,
            "passive_trade_mode": _offer_mode(observed),
            "passive_trade_flags": {
                "is_no_offer": observed.offer_is_no_offer,
                "is_buy_only": observed.offer_is_buy_only,
                "is_sell_only": observed.offer_is_sell_only,
                "is_buy_or_sell": observed.offer_is_buy_or_sell,
                "is_preferred_good": observed.offer_is_preferred_good,
            },
            "low_target": low_target,
            "high_target": high_target,
            "policy_source": "explicit" if policy else "passive_trade" if passive_min and passive_min > 0 else "capacity_default",
            "priority": policy.priority if policy else 0,
            "excluded": policy.excluded if policy else False,
            "velocity": rate,
            "estimated_stockout_minutes": round(eta, 1) if eta is not None else None,
            "observed_at": _iso(observed.observed_at),
            "observation_snapshot_id": observed.snapshot_id,
            "observation_play_session_id": observed.play_session_id,
            "section_status": observed.section_status,
        }
        items.append(item)
        if available is not None and low_target is not None and available < low_target:
            signals.append(
                _signal("low_stock", "critical" if available <= low_target * 0.5 else "warning", item)
            )
        if fill is not None and fill >= 0.9:
            signals.append(_signal("near_full", "warning", item))
        if current_rate and current_rate["net_stock_change_per_minute"] < 0:
            signals.append(_signal("falling_stock", "warning", item))
        if eta is not None and eta <= 30:
            signals.append(
                _signal("estimated_stockout", "critical" if eta <= 10 else "warning", item)
            )
    severity_order = {"critical": 0, "warning": 1, "info": 2}
    signals.sort(key=lambda value: (severity_order.get(value["severity"], 9), -value.get("priority", 0)))
    return {"meta": meta, "catalog": coverage, "items": items, "signals": signals}


def _signal(code: str, severity: str, item: dict) -> dict:
    labels = {
        "low_stock": "Stock is below the management target",
        "near_full": "Storage is near capacity",
        "falling_stock": "Net stock is falling",
        "estimated_stockout": "Estimated stockout within 30 game minutes",
    }
    return {
        "code": code,
        "severity": severity,
        "label": labels[code],
        "area_pk": item["area_pk"],
        "area_name": item["area_name"],
        "product_guid": item["product_guid"],
        "product_name": item["product_name"],
        "priority": item["priority"],
        "evidence": {
            "stock": item["stock"],
            "available_stock": item["available_stock"],
            "capacity": item["capacity"],
            "low_target": item["low_target"],
            "net_stock_change_per_minute": (
                item["velocity"]["net_stock_change_per_minute"]
                if item["velocity"] and not item["velocity"].get("is_historical", False)
                else None
            ),
        },
        "interpretation": "inferred_pressure",
    }


def trade_opportunities(inventory: dict) -> list[dict]:
    by_product: dict[str, list[dict]] = defaultdict(list)
    for item in inventory["items"]:
        if not item["excluded"]:
            by_product[item["product_guid"]].append(item)
    opportunities: list[dict] = []
    for product_guid, items in by_product.items():
        sources = [
            item
            for item in items
            if item["available_stock"] is not None
            and item["high_target"] is not None
            and item["available_stock"] > item["high_target"]
        ]
        destinations = [
            item
            for item in items
            if item["available_stock"] is not None
            and item["low_target"] is not None
            and item["available_stock"] < item["low_target"]
        ]
        for destination in destinations:
            for source in sources:
                if source["area_pk"] == destination["area_pk"]:
                    continue
                amount = min(
                    source["available_stock"] - source["high_target"],
                    destination["low_target"] - destination["available_stock"],
                )
                if amount <= 0:
                    continue
                opportunities.append(
                    {
                        "product_guid": product_guid,
                        "product_name": source["product_name"],
                        "source_area_pk": source["area_pk"],
                        "source_area_name": source["area_name"],
                        "destination_area_pk": destination["area_pk"],
                        "destination_area_name": destination["area_name"],
                        "advisory_amount": round(amount, 1),
                        "source_available_stock": source["available_stock"],
                        "source_high_target": source["high_target"],
                        "projected_source_stock": round(source["available_stock"] - amount, 1),
                        "destination_available_stock": destination["available_stock"],
                        "destination_low_target": destination["low_target"],
                        "projected_destination_stock": round(destination["available_stock"] + amount, 1),
                        "destination_priority": destination["priority"],
                        "route_feasibility": "unknown",
                        "interpretation": "transfer_candidate",
                    }
                )
    return sorted(
        opportunities,
        key=lambda value: (-value["destination_priority"], -value["advisory_amount"]),
    )


def inventory_history(
    session: Session,
    *,
    area_pk: int,
    product_guid: str,
    play_session_id: str,
    limit: int = 240,
) -> list[dict]:
    rows = _session_stock_samples(
        session,
        play_session_id,
        area_pk=area_pk,
        product_guids=[product_guid],
    ).get((area_pk, product_guid), [])[-limit:]
    return [
        {
            "snapshot_id": sample["snapshot"].snapshot_id,
            "play_session_id": sample["snapshot"].play_session_id,
            "observed_at": _iso(
                sample["snapshot"].completed_at or sample["snapshot"].received_at
            ),
            "play_time": sample["snapshot"].play_time,
            "stock": sample["stock"],
            "available_stock": sample["available_stock"],
            "capacity": sample["capacity"],
            "sample_kind": sample["sample_kind"],
        }
        for sample in rows
    ]


def inventory_history_group(
    session: Session,
    *,
    area_pk: int,
    product_guids: list[str],
    play_session_id: str,
    limit: int = 240,
) -> list[dict]:
    samples = _session_stock_samples(
        session,
        play_session_id,
        area_pk=area_pk,
        product_guids=product_guids,
    )
    return [
        {
            "product_guid": guid,
            "items": [
                {
                    "snapshot_id": sample["snapshot"].snapshot_id,
                    "play_session_id": sample["snapshot"].play_session_id,
                    "observed_at": _iso(
                        sample["snapshot"].completed_at or sample["snapshot"].received_at
                    ),
                    "play_time": sample["snapshot"].play_time,
                    "stock": sample["stock"],
                    "available_stock": sample["available_stock"],
                    "capacity": sample["capacity"],
                    "sample_kind": sample["sample_kind"],
                }
                for sample in samples.get((area_pk, guid), [])[-limit:]
            ],
        }
        for guid in product_guids
    ]
def finance_latest(session: Session, snapshot: SnapshotBatch | None) -> dict | None:
    if snapshot is None:
        return None
    finance = session.scalars(
        select(ParticipantFinanceObservation).where(
            ParticipantFinanceObservation.snapshot_id == snapshot.snapshot_id
        )
    ).first()
    if finance is None:
        return None
    categories = session.scalars(
        select(FinanceCategoryObservation)
        .where(
            FinanceCategoryObservation.snapshot_id == snapshot.snapshot_id,
            FinanceCategoryObservation.participant_guid == finance.participant_guid,
        )
        .order_by(FinanceCategoryObservation.kind, FinanceCategoryObservation.ordinal)
    ).all()
    return {
        "participant_guid": finance.participant_guid,
        "treasury": finance.treasury,
        "total_balance_raw": finance.total_balance_raw,
        "trade_balance_period_raw": finance.trade_balance_period_raw,
        "passive_trade_balance_period_raw": finance.passive_trade_balance_period_raw,
        "active_trade_balance_period_raw": finance.active_trade_balance_period_raw,
        "categories": [
            {
                "kind": item.kind,
                "ordinal": item.ordinal,
                "category_guid_raw": item.category_guid_raw,
                "localized_label": item.localized_label,
                "value": item.value,
            }
            for item in categories
        ],
    }


def workforce_latest(session: Session, snapshot: SnapshotBatch | None) -> list[dict]:
    if snapshot is None:
        return []
    play = session.get(PlaySession, snapshot.play_session_id)
    if play is None or play.campaign_id is None:
        return []
    rows = session.execute(
        select(AreaWorkforceObservation, Area, SnapshotBatch)
        .join(Area, Area.area_pk == AreaWorkforceObservation.area_pk)
        .join(SnapshotBatch, SnapshotBatch.snapshot_id == AreaWorkforceObservation.snapshot_id)
        .join(PlaySession, PlaySession.play_session_id == SnapshotBatch.play_session_id)
        .where(SnapshotBatch.is_complete.is_(True), PlaySession.campaign_id == play.campaign_id)
        .order_by(SnapshotBatch.completed_at.desc(), SnapshotBatch.snapshot_id.desc(), AreaWorkforceObservation.ordinal)
    ).all()
    latest: dict[tuple[int, str], tuple] = {}
    for item, area, observed_snapshot in rows:
        latest.setdefault((area.area_pk, item.workforce_guid), (item, area, observed_snapshot))
    return [
        {
            "area_pk": area.area_pk,
            "area_name": area.latest_name or area.area_id_raw,
            "scope": item.scope_kind,
            "workforce_guid": item.workforce_guid,
            "name": item.localized_name,
            "population_count": item.population_count,
            "resulting_from_population": item.resulting_from_population,
            "registered_production": item.registered_production,
            "registered_consumption": item.registered_consumption,
            "delta_without_buffs": item.delta_without_buffs,
            "delta_with_buffs": item.delta_with_buffs,
            "observed_at": _iso(observed_snapshot.completed_at or observed_snapshot.received_at),
            "snapshot_id": observed_snapshot.snapshot_id,
            "is_last_observed": observed_snapshot.snapshot_id != snapshot.snapshot_id,
        }
        for item, area, observed_snapshot in latest.values()
    ]


def route_issues_latest(session: Session, snapshot: SnapshotBatch | None) -> list[dict]:
    if snapshot is None:
        return []
    rows = session.scalars(
        select(TradeRouteIssueObservation)
        .where(TradeRouteIssueObservation.snapshot_id == snapshot.snapshot_id)
        .order_by(TradeRouteIssueObservation.ordinal, TradeRouteIssueObservation.issue_code)
    ).all()
    engine_codes = {
        0: "not_enough_slots", 1: "not_enough_stations", 2: "island_under_siege",
        3: "no_valid_pier", 4: "no_trade_rights", 5: "configured_good_not_traded",
        6: "loaded_good_never_unloaded", 7: "unloaded_good_never_loaded",
        8: "goods_dont_match", 9: "storage_full", 10: "storage_empty", 11: "no_goods",
        12: "no_ships", 13: "all_ships_paused", 14: "long_waiting_time",
        15: "mismatching_good", 16: "goods_dropped",
    }
    details = {
        "not_enough_slots": ("Not enough cargo slots", "Reduce the configured goods or assign a ship with enough cargo slots."),
        "not_enough_stations": ("Not enough stops", "Add the missing loading or unloading stop to the in-game route."),
        "island_under_siege": ("Island under siege", "Review the affected stop and secure access before relying on this route."),
        "no_valid_pier": ("No valid pier", "Check that each route stop has a reachable trading post or pier."),
        "no_trade_rights": ("No trade rights", "Review diplomacy for the affected external trading stop."),
        "configured_good_not_traded": ("Configured good is not traded", "Review the loading and unloading instructions for this good."),
        "loaded_good_never_unloaded": ("Loaded cargo has no unload stop", "Add an unload instruction for every good loaded on the route."),
        "unloaded_good_never_loaded": ("Unload has no matching load", "Add a loading instruction for the configured good."),
        "goods_dont_match": ("Loading and unloading goods do not match", "Align the goods configured at the route's loading and unloading stops."),
        "storage_full": ("Destination storage is full", "Reduce deliveries or create demand at the affected destination."),
        "storage_empty": ("Source storage is empty", "Reduce the pickup amount or improve supply at the source."),
        "no_goods": ("Route has no goods", "Configure at least one loading and unloading instruction."),
        "no_ships": ("Route has no ships", "Assign an in-game ship to this route."),
        "all_ships_paused": ("All route ships are paused", "Resume a ship in Anno when you are ready to run the route."),
        "long_waiting_time": ("Long loading wait", "Review pier capacity, storage availability, and route timing."),
        "mismatching_good": ("Mismatching cargo", "Check that every loaded good has a matching unload instruction on this route."),
        "goods_dropped": ("Cargo was discarded", "Review loading amounts and available cargo slots on the assigned ships."),
    }
    result = []
    reverse_engine_codes = {value: key for key, value in engine_codes.items()}
    for item in rows:
        code = item.issue_code
        engine_error_code = None
        if code.startswith("engine_error_"):
            try:
                engine_error_code = int(code.removeprefix("engine_error_"))
            except ValueError:
                pass
            code = engine_codes.get(engine_error_code, code)
        else:
            engine_error_code = reverse_engine_codes.get(code)
        label, guidance = details.get(
            code,
            (code.replace("_", " ").title(), "Review this route in Anno for the engine-reported issue."),
        )
        result.append({
            "route_name": item.route_name,
            "issue_code": code,
            "engine_error_code": engine_error_code,
            "label": label,
            "guidance": guidance,
            "severity": item.severity,
            "active_error_count": item.active_error_count,
            "identity_scope": "ephemeral_route_name",
        })
    return result


def active_trade_routes(
    session: Session,
    campaign_id: str | None,
    snapshot: SnapshotBatch | None,
    *,
    stale_after_seconds: int,
) -> dict:
    """Return persistent route names backed by assigned ships or current issue evidence."""
    section = None
    if snapshot is not None:
        section = session.scalar(
            select(SnapshotSectionStatus).where(
                SnapshotSectionStatus.snapshot_id == snapshot.snapshot_id,
                SnapshotSectionStatus.section_name == "active_routes",
                SnapshotSectionStatus.area_id_raw.is_(None),
            )
        )
    telemetry_status = section.status if section is not None else "not_observed"
    current_routes = []
    if campaign_id is not None:
        current_routes = session.scalars(
            select(ActiveTradeRouteCurrent).where(
                ActiveTradeRouteCurrent.campaign_id == campaign_id,
                ActiveTradeRouteCurrent.is_active.is_(True),
            ).order_by(ActiveTradeRouteCurrent.route_name, ActiveTradeRouteCurrent.game_session_guid)
        ).all()
    route_keys = [item.route_key for item in current_routes]
    ships_by_route: dict[str, list[ActiveTradeRouteShipCurrent]] = defaultdict(list)
    if route_keys:
        for ship in session.scalars(
            select(ActiveTradeRouteShipCurrent)
            .where(ActiveTradeRouteShipCurrent.route_key.in_(route_keys))
            .order_by(ActiveTradeRouteShipCurrent.ship_id_raw)
        ).all():
            ships_by_route[ship.route_key].append(ship)

    issues = route_issues_latest(session, snapshot)
    issues_by_name: dict[str, list[dict]] = defaultdict(list)
    for issue in issues:
        if issue.get("route_name"):
            issues_by_name[str(issue["route_name"])].append(issue)

    now = datetime.now(UTC)
    items: list[dict] = []
    observed_names: set[str] = set()
    for route in current_routes:
        observed_names.add(route.route_name)
        observed_at = route.last_seen_at
        if observed_at.tzinfo is None:
            observed_at = observed_at.replace(tzinfo=UTC)
        freshness = max(0.0, (now - observed_at).total_seconds())
        if route.assigned_ship_count > 0 and route.paused_ship_count >= route.assigned_ship_count:
            status = "paused"
        elif route.paused_ship_count > 0:
            status = "partially_paused"
        else:
            status = "running"
        items.append({
            "route_key": route.route_key,
            "route_name": route.route_name,
            "identity_scope": route.identity_scope,
            "evidence_kind": "assigned_ships",
            "status": status,
            "is_active_last_observed": True,
            "assigned_ship_count": route.assigned_ship_count,
            "paused_ship_count": route.paused_ship_count,
            "regular_ship_count": route.regular_ship_count,
            "game_session_guid": route.game_session_guid,
            "region_guid": route.region_guid,
            "observed_at": _iso(route.last_seen_at),
            "freshness_seconds": round(freshness, 1),
            "is_stale": freshness > stale_after_seconds,
            "issues": issues_by_name.get(route.route_name, []),
            "ships": [{
                "ship_id": ship.ship_id_raw,
                "ship_name": ship.ship_name,
                "ship_guid": ship.ship_guid,
                "game_session_guid": ship.game_session_guid,
                "area_id": ship.area_id_raw,
                "is_paused": ship.is_paused,
                "on_regular_route": ship.on_regular_route,
                "loading_speed_factor": ship.loading_speed_factor,
            } for ship in ships_by_route[route.route_key]],
        })

    snapshot_time = (snapshot.completed_at or snapshot.received_at) if snapshot is not None else None
    snapshot_freshness = None
    if snapshot_time is not None:
        if snapshot_time.tzinfo is None:
            snapshot_time = snapshot_time.replace(tzinfo=UTC)
        snapshot_freshness = max(0.0, (now - snapshot_time).total_seconds())
    for route_name, route_issues in sorted(issues_by_name.items()):
        if route_name in observed_names:
            continue
        issue_key = hashlib.sha256(
            f"{campaign_id or 'unknown'}|issue|{route_name}".encode()
        ).hexdigest()
        items.append({
            "route_key": f"issue-{issue_key}",
            "route_name": route_name,
            "identity_scope": "mutable_route_name",
            "evidence_kind": "issue_only",
            "status": "issue_reported",
            "is_active_last_observed": None,
            "assigned_ship_count": None,
            "paused_ship_count": None,
            "regular_ship_count": None,
            "game_session_guid": snapshot.current_game_session_guid if snapshot else None,
            "region_guid": snapshot.current_region_guid if snapshot else None,
            "observed_at": _iso(snapshot_time),
            "freshness_seconds": round(snapshot_freshness, 1) if snapshot_freshness is not None else None,
            "is_stale": snapshot_freshness is None or snapshot_freshness > stale_after_seconds,
            "issues": route_issues,
            "ships": [],
        })

    items.sort(key=lambda item: (
        item["evidence_kind"] != "assigned_ships",
        not bool(item["issues"]),
        item["route_name"].casefold(),
    ))
    return {
        "campaign_id": campaign_id,
        "telemetry_status": telemetry_status,
        "scope": "assigned_trade_route_ships_in_observed_game_session",
        "identity_notice": "Anno exposes a mutable route name but no stable route ID. Renamed or duplicate names may appear as separate or merged records.",
        "capabilities": {
            "assigned_ships": telemetry_status == "success" or bool(current_routes),
            "route_issues": True,
            "stops": False,
            "configured_goods": False,
            "ship_cargo": False,
        },
        "counts": {
            "ship_backed_routes": sum(item["evidence_kind"] == "assigned_ships" for item in items),
            "issue_only_routes": sum(item["evidence_kind"] == "issue_only" for item in items),
            "assigned_ships": sum(item["assigned_ship_count"] or 0 for item in items),
        },
        "items": items,
    }


def production_chains(session: Session, inventory: dict) -> dict:
    release_id = inventory["catalog"].get("release_id")
    if not release_id:
        return {"catalog": inventory["catalog"], "chains": []}
    products = {
        item.product_guid: item
        for item in session.scalars(select(Product).where(Product.release_id == release_id)).all()
    }
    buildings = {
        item.building_guid: item
        for item in session.scalars(select(BuildingType).where(BuildingType.release_id == release_id)).all()
    }
    recipes = session.scalars(
        select(ProductionRecipe).where(ProductionRecipe.release_id == release_id)
    ).all()
    recipe_items_by_id: dict[str, list[ProductionRecipeItem]] = defaultdict(list)
    for recipe_item in session.scalars(
        select(ProductionRecipeItem)
        .where(ProductionRecipeItem.release_id == release_id)
        .order_by(
            ProductionRecipeItem.recipe_id,
            ProductionRecipeItem.role,
            ProductionRecipeItem.ordinal,
        )
    ).all():
        recipe_items_by_id[recipe_item.recipe_id].append(recipe_item)
    campaign_id = resolve_campaign_id(session)
    areas = session.scalars(
        select(Area).where(Area.campaign_id == campaign_id).order_by(Area.confirmed_region_guid, Area.latest_name)
    ).all() if campaign_id else []
    building_state = {
        (item.area_pk, item.building_guid): item
        for item in session.scalars(
            select(AreaBuildingCurrent).where(AreaBuildingCurrent.campaign_id == campaign_id)
        ).all()
    } if campaign_id else {}
    inventory_by_area_product = {
        (item["area_pk"], item["product_guid"]): item for item in inventory["items"]
    }
    maintenance = defaultdict(list)
    for item in session.scalars(
        select(BuildingMaintenanceItem).where(BuildingMaintenanceItem.release_id == release_id)
    ).all():
        maintenance[item.building_guid].append(item)
    chains = []
    for recipe in recipes:
        items = recipe_items_by_id[recipe.recipe_id]
        chain_items = [
            {
                "role": item.role,
                "ordinal": item.ordinal,
                "product_guid": item.product_guid,
                "product_name": products[item.product_guid].name if item.product_guid in products else None,
                "amount": item.amount,
            }
            for item in items
        ]
        roles_by_product: dict[str, set[str]] = defaultdict(set)
        for item in chain_items:
            roles_by_product[item["product_guid"]].add(item["role"])
        pressures = []
        for signal in inventory["signals"]:
            roles = roles_by_product.get(signal["product_guid"], set())
            if "input" in roles and signal["code"] in {
                "low_stock", "falling_stock", "estimated_stockout"
            }:
                pressures.append(
                    {**signal, "chain_role": "input", "chain_issue": "input_pressure"}
                )
            if "output" in roles and signal["code"] == "near_full":
                pressures.append(
                    {**signal, "chain_role": "output", "chain_issue": "output_blockage"}
                )
        building = buildings.get(recipe.building_guid)
        city_states = []
        for area in areas:
            state = building_state.get((area.area_pk, recipe.building_guid))
            city_pressures = [
                item for item in pressures
                if item["area_pk"] == area.area_pk
                and state is not None
                and state.presence_status == "installed"
            ]
            stocks = []
            for chain_item in chain_items:
                observed = inventory_by_area_product.get((area.area_pk, chain_item["product_guid"]))
                stocks.append(
                    {
                        **chain_item,
                        "stock": observed["stock"] if observed else None,
                        "capacity": observed["capacity"] if observed else None,
                        "fill_ratio": observed["fill_ratio"] if observed else None,
                        "net_stock_change": observed["velocity"] if observed else None,
                    }
                )
            city_states.append(
                {
                    "area_pk": area.area_pk,
                    "area_name": area.latest_name or area.area_id_raw,
                    "region_guid": area.confirmed_region_guid,
                    "building_count": state.building_count if state else None,
                    "presence_status": state.presence_status if state else "unknown",
                    "observed_at": _iso(state.observed_at) if state else None,
                    "inferred_pressures": city_pressures,
                    "stocks": stocks,
                }
            )
        money_maintenance = next(
            (item.amount for item in maintenance[recipe.building_guid] if item.kind == "money"), None
        )
        chains.append(
            {
                "recipe_id": recipe.recipe_id,
                "name": recipe.name or (building.name if building else recipe.recipe_id),
                "building_guid": recipe.building_guid,
                "building_name": building.name if building else None,
                "workforce_guid": building.workforce_guid if building else None,
                "workforce_name": workforce_name(building.workforce_guid if building else None),
                "cycle_seconds": recipe.cycle_seconds,
                "items": chain_items,
                "inferred_pressures": pressures,
                "associated_regions": json.loads(building.associated_regions_json or "[]") if building else [],
                "base_maintenance": money_maintenance,
                "city_states": city_states,
                "measurement_notice": "Stock-based inferred pressure; no measured factory rate.",
            }
        )
    return {"catalog": inventory["catalog"], "chains": chains}


def finance_history(session: Session, snapshot: SnapshotBatch | None, limit: int = 120) -> list[dict]:
    if snapshot is None:
        return []
    rows = session.execute(
        select(ParticipantFinanceObservation, SnapshotBatch)
        .join(SnapshotBatch, SnapshotBatch.snapshot_id == ParticipantFinanceObservation.snapshot_id)
        .where(
            SnapshotBatch.play_session_id == snapshot.play_session_id,
            SnapshotBatch.is_complete.is_(True),
            SnapshotBatch.snapshot_sequence <= snapshot.snapshot_sequence,
        )
        .order_by(SnapshotBatch.snapshot_sequence.desc())
        .limit(limit)
    ).all()
    return [
        {
            "snapshot_id": batch.snapshot_id,
            "play_session_id": batch.play_session_id,
            "observed_at": _iso(batch.completed_at or batch.received_at),
            "play_time": batch.play_time,
            "treasury": item.treasury,
            "reported_balance": item.total_balance_raw,
            "trade_balance": item.trade_balance_period_raw,
            "passive_trade_balance": item.passive_trade_balance_period_raw,
            "active_trade_balance": item.active_trade_balance_period_raw,
        }
        for item, batch in reversed(rows)
    ]


def finance_analysis(session: Session, snapshot: SnapshotBatch | None) -> dict | None:
    current = finance_latest(session, snapshot)
    if current is None:
        return None
    history = finance_history(session, snapshot)
    valid = [point for point in history if point["treasury"] is not None and point["play_time"] is not None]
    treasury_change = None
    treasury_change_per_minute = None
    if len(valid) >= 2 and valid[-1]["play_time"] > valid[0]["play_time"]:
        treasury_change = valid[-1]["treasury"] - valid[0]["treasury"]
        elapsed = (valid[-1]["play_time"] - valid[0]["play_time"]) / 60_000
        treasury_change_per_minute = treasury_change / elapsed if elapsed else None
    categories = [item for item in current["categories"] if item["value"] is not None]
    positives = sorted((item for item in categories if item["value"] > 0), key=lambda item: -item["value"])
    negatives = sorted((item for item in categories if item["value"] < 0), key=lambda item: item["value"])
    gross_income = sum(item["value"] for item in positives)
    gross_expenses = abs(sum(item["value"] for item in negatives))
    reported_negative = (current["total_balance_raw"] or 0) < 0
    treasury_falling = treasury_change is not None and treasury_change < 0
    estimated_maintenance = {
        "total": 0.0,
        "cities": [],
        "notice": "Estimated base maintenance from catalog costs and observed factory counts; buffs and other modifiers are excluded.",
    }
    play = session.get(PlaySession, snapshot.play_session_id) if snapshot is not None else None
    if play is not None and play.campaign_id:
        money_by_building = {
            item.building_guid: item.amount
            for item in session.scalars(
                select(BuildingMaintenanceItem).where(
                    BuildingMaintenanceItem.release_id == play.static_release_id,
                    BuildingMaintenanceItem.kind == "money",
                )
            ).all()
        }
        building_names = {
            item.building_guid: item.name
            for item in session.scalars(
                select(BuildingType).where(BuildingType.release_id == play.static_release_id)
            ).all()
        }
        by_city: dict[int, dict[str, Any]] = {}
        rows = session.execute(
            select(AreaBuildingCurrent, Area)
            .join(Area, Area.area_pk == AreaBuildingCurrent.area_pk)
            .where(
                AreaBuildingCurrent.campaign_id == play.campaign_id,
                AreaBuildingCurrent.presence_status == "installed",
                AreaBuildingCurrent.building_count > 0,
            )
        ).all()
        for observed, area in rows:
            unit_cost = money_by_building.get(observed.building_guid)
            if unit_cost is None:
                continue
            subtotal = unit_cost * observed.building_count
            city = by_city.setdefault(
                area.area_pk,
                {
                    "area_pk": area.area_pk,
                    "area_name": area.latest_name or area.area_id_raw,
                    "estimated_base_maintenance": 0.0,
                    "factories": [],
                },
            )
            city["estimated_base_maintenance"] += subtotal
            city["factories"].append(
                {
                    "building_guid": observed.building_guid,
                    "building_name": building_names.get(observed.building_guid, observed.building_guid),
                    "count": observed.building_count,
                    "base_maintenance_each": unit_cost,
                    "estimated_base_maintenance": subtotal,
                }
            )
        estimated_maintenance["cities"] = sorted(
            by_city.values(), key=lambda item: -item["estimated_base_maintenance"]
        )
        estimated_maintenance["total"] = sum(
            item["estimated_base_maintenance"] for item in estimated_maintenance["cities"]
        )
    guidance = []
    if reported_negative:
        category = negatives[0] if negatives else None
        guidance.append({
            "code": "reported_balance_negative",
            "title": "Reported balance is negative",
            "suggestion": f"Review {category['localized_label'] or category['category_guid_raw']} first; it is the largest observed negative category." if category else "Review recurring expense categories and base factory maintenance.",
            "evidence": category or {"reported_balance": current["total_balance_raw"]},
        })
    if treasury_falling:
        guidance.append({
            "code": "treasury_falling",
            "title": "Treasury is falling",
            "suggestion": "Stabilize the highest-priority shortages and review costly or idle production chains.",
            "evidence": {"treasury_change": treasury_change, "treasury_change_per_game_minute": treasury_change_per_minute},
        })
    if reported_negative and estimated_maintenance["cities"]:
        city = estimated_maintenance["cities"][0]
        factory = max(
            city["factories"], key=lambda item: item["estimated_base_maintenance"]
        )
        guidance.append({
            "code": "estimated_base_maintenance",
            "title": f"Review base maintenance in {city['area_name']}",
            "suggestion": f"{factory['building_name']} contributes the largest observed factory subtotal there; confirm whether that capacity is currently needed.",
            "evidence": {
                "area_pk": city["area_pk"],
                "area_name": city["area_name"],
                **factory,
                "interpretation": "estimated_base_maintenance",
                "excludes_buffs": True,
            },
        })
    return {
        "reported_balance": current["total_balance_raw"],
        "reported_balance_is_negative": reported_negative,
        "treasury": current["treasury"],
        "treasury_is_falling": treasury_falling,
        "treasury_change": treasury_change,
        "treasury_change_per_game_minute": round(treasury_change_per_minute, 2) if treasury_change_per_minute is not None else None,
        "trade_balance": {
            "total": current["trade_balance_period_raw"],
            "passive": current["passive_trade_balance_period_raw"],
            "active": current["active_trade_balance_period_raw"],
        },
        "category_totals": {
            "gross_income": round(gross_income, 2),
            "gross_expenses": round(gross_expenses, 2),
            "net_profit": round(gross_income - gross_expenses, 2),
            "interpretation": "sum_of_observed_finance_categories",
        },
        "largest_positive_categories": positives[:5],
        "largest_negative_categories": negatives[:5],
        "estimated_base_maintenance": estimated_maintenance,
        "guidance": guidance,
    }


def suggested_routes(session: Session, inventory: dict) -> list[dict]:
    release_id = inventory["catalog"].get("release_id")
    campaign_id = resolve_campaign_id(session)
    installed = set()
    if campaign_id:
        installed = {
            (item.area_pk, item.building_guid)
            for item in session.scalars(
                select(AreaBuildingCurrent).where(
                    AreaBuildingCurrent.campaign_id == campaign_id,
                    AreaBuildingCurrent.presence_status == "installed",
                    AreaBuildingCurrent.building_count > 0,
                )
            ).all()
        }
    input_buildings: dict[str, set[str]] = defaultdict(set)
    if release_id:
        rows = session.execute(
            select(ProductionRecipeItem.product_guid, ProductionRecipe.building_guid)
            .join(
                ProductionRecipe,
                and_(
                    ProductionRecipe.release_id == ProductionRecipeItem.release_id,
                    ProductionRecipe.recipe_id == ProductionRecipeItem.recipe_id,
                ),
            )
            .where(
                ProductionRecipeItem.release_id == release_id,
                ProductionRecipeItem.role == "input",
            )
        ).all()
        for product_guid, building_guid in rows:
            input_buildings[product_guid].add(building_guid)
    signal_codes: dict[tuple[int, str], set[str]] = defaultdict(set)
    for signal in inventory["signals"]:
        signal_codes[(signal["area_pk"], signal["product_guid"])].add(signal["code"])

    grouped: dict[tuple[int, int], list[dict]] = defaultdict(list)
    for item in trade_opportunities(inventory):
        destination_key = (item["destination_area_pk"], item["product_guid"])
        codes = signal_codes[destination_key]
        active_input = any(
            (item["destination_area_pk"], building_guid) in installed
            for building_guid in input_buildings[item["product_guid"]]
        )
        score = max(0, item["destination_priority"]) * 5
        score += 10 if "estimated_stockout" in codes else 0
        score += 5 if "low_stock" in codes else 0
        score += 3 if "falling_stock" in codes else 0
        score += 7 if active_input else 0
        grouped[(item["source_area_pk"], item["destination_area_pk"])].append({
            **item,
            "active_production_input": active_input,
            "imminent_stockout": "estimated_stockout" in codes,
            "priority_score": score,
        })
    result = []
    for (source_pk, destination_pk), goods in grouped.items():
        goods.sort(key=lambda item: (-item["priority_score"], -item["advisory_amount"]))
        urgency = sum(item["priority_score"] + 1 for item in goods)
        reasons = []
        if any(item["active_production_input"] for item in goods): reasons.append("active production inputs")
        if any(item["imminent_stockout"] for item in goods): reasons.append("estimated stockout risk")
        if any(item["destination_priority"] > 0 for item in goods): reasons.append("explicit destination priority")
        reason_suffix = f" Priority includes {', '.join(reasons)}." if reasons else ""
        suggestion_id = f"route:{source_pk}:{destination_pk}"
        selected_goods = goods[:8]
        result.append({
            "suggestion_id": suggestion_id,
            "action_id": "act_" + hashlib.sha256(suggestion_id.encode()).hexdigest()[:20],
            "source_area_pk": source_pk,
            "source_area_name": goods[0]["source_area_name"],
            "destination_area_pk": destination_pk,
            "destination_area_name": goods[0]["destination_area_name"],
            "goods": [
                {
                    "product_guid": item["product_guid"],
                    "product_name": item["product_name"],
                    "advisory_amount": item["advisory_amount"],
                    "active_production_input": item["active_production_input"],
                    "imminent_stockout": item["imminent_stockout"],
                    "source_available_stock": item["source_available_stock"],
                    "source_high_target": item["source_high_target"],
                    "projected_source_stock": item["projected_source_stock"],
                    "destination_available_stock": item["destination_available_stock"],
                    "destination_low_target": item["destination_low_target"],
                    "projected_destination_stock": item["projected_destination_stock"],
                }
                for item in selected_goods
            ],
            "confidence": "high" if urgency >= 8 else "medium",
            "reason": f"A focused bundle of {len(selected_goods)} good{'s' if len(selected_goods) != 1 else ''} was selected from {len(goods)} observed destination deficit{'s' if len(goods) != 1 else ''}; each amount is bounded by source surplus and destination need.{reason_suffix}",
            "evidence": {
                "priority_score": urgency,
                "candidate_goods_count": len(goods),
                "planned_goods_count": len(selected_goods),
            },
            "route_feasibility": "unknown",
        })
    return sorted(result, key=lambda item: (-item["evidence"]["priority_score"], -len(item["goods"])))


def deterministic_action_specs(
    inventory: dict,
    balance: dict | None,
    routes: list[dict],
    workforce: list[dict],
    route_issues: list[dict],
    planned_pairs: set[tuple[int, int]] | None = None,
    chains: list[dict] | None = None,
) -> list[dict]:
    specs: list[dict] = []
    planned_pairs = planned_pairs or set()
    if balance:
        for item in balance["guidance"]:
            specs.append({
                "key": item["code"], "kind": "finance", "severity": "critical" if item["code"] == "reported_balance_negative" else "warning",
                "title": item["title"], "summary": item["suggestion"], "evidence": item["evidence"], "deep_link": "/#balance",
            })
    for signal in inventory["signals"][:20]:
        specs.append({
            "key": f"stock:{signal['code']}:{signal['area_pk']}:{signal['product_guid']}",
            "kind": "stock", "severity": signal["severity"],
            "title": f"{signal['product_name']} · {signal['area_name']}", "summary": signal["label"],
            "evidence": signal["evidence"], "deep_link": f"/areas/{signal['area_pk']}?product={signal['product_guid']}",
        })
    chain_actions: set[tuple[int, str, str, str]] = set()
    for chain in chains or []:
        for city in chain["city_states"]:
            for pressure in city["inferred_pressures"]:
                key = (
                    city["area_pk"], chain["recipe_id"], pressure["product_guid"],
                    pressure["chain_issue"],
                )
                if key in chain_actions:
                    continue
                chain_actions.add(key)
                label = "Input pressure" if pressure["chain_issue"] == "input_pressure" else "Output blockage"
                specs.append({
                    "key": f"chain:{key[0]}:{key[1]}:{key[2]}:{key[3]}",
                    "kind": pressure["chain_issue"],
                    "severity": pressure["severity"],
                    "title": f"{label} · {chain['name']} · {city['area_name']}",
                    "summary": f"{pressure['product_name']}: {pressure['label'].lower()} for an observed installed factory chain.",
                    "evidence": {
                        "area_pk": city["area_pk"], "area_name": city["area_name"],
                        "recipe_id": chain["recipe_id"], "building_guid": chain["building_guid"],
                        "product_guid": pressure["product_guid"], "chain_issue": pressure["chain_issue"],
                    },
                    "deep_link": f"/production?city={city['area_pk']}&chain={chain['recipe_id']}",
                })
    for route in routes[:5]:
        names = ", ".join(item["product_name"] for item in route["goods"][:3])
        pair = (route["source_area_pk"], route["destination_area_pk"])
        if pair in planned_pairs:
            specs.append({
                "key": f"review_{route['suggestion_id']}", "kind": "route_capacity", "severity": "warning",
                "title": f"Review route capacity · {route['source_area_name']} → {route['destination_area_name']}",
                "summary": f"A companion plan exists, but observed deficits remain for {names}; verify the in-game route and capacity.",
                "evidence": {**route, "existing_companion_plan": True}, "deep_link": "/trade",
            })
        else:
            specs.append({
                "key": route["suggestion_id"], "kind": "transfer", "severity": "warning",
                "title": f"Plan {route['source_area_name']} → {route['destination_area_name']}",
                "summary": f"Move {names} from observed surplus toward observed deficits.",
                "evidence": route, "deep_link": "/trade",
            })
    for item in workforce:
        if item["delta_without_buffs"] is not None and item["delta_without_buffs"] < 0:
            specs.append({
                "key": f"workforce:{item['area_pk']}:{item['workforce_guid']}", "kind": "workforce", "severity": "critical",
                "title": f"Workforce shortage · {item['area_name']}", "summary": f"Observed {item['name'] or item['workforce_guid']} deficit of {abs(item['delta_without_buffs']):.1f}.",
                "evidence": item, "deep_link": f"/areas/{item['area_pk']}",
            })
    for index, issue in enumerate(route_issues):
        specs.append({
            "key": f"route_issue:{issue['route_name']}:{issue['issue_code']}:{index}", "kind": "route_issue", "severity": issue["severity"],
            "title": issue["route_name"] or "Route warning",
            "summary": f"{issue['label']}. {issue['guidance']}",
            "evidence": issue, "deep_link": "/trade",
        })
    for spec in specs:
        spec["action_id"] = "act_" + hashlib.sha256(spec.pop("key").encode()).hexdigest()[:20]
    order = {"critical": 0, "warning": 1, "info": 2}
    return sorted(specs, key=lambda item: (order.get(item["severity"], 9), item["title"]))
