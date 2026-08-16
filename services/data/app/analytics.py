from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime
from statistics import median
from typing import Any

from sqlalchemy import and_, select
from sqlalchemy.orm import Session

from .catalog import catalog_summary
from .models import (
    Area,
    AreaProductObservation,
    AreaProductPolicy,
    AreaSnapshot,
    AreaWorkforceObservation,
    BuildingType,
    FinanceCategoryObservation,
    ParticipantFinanceObservation,
    PlaySession,
    Product,
    ProductionRecipe,
    ProductionRecipeItem,
    SnapshotBatch,
    TradeRouteIssueObservation,
)


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


def _velocity_map(
    session: Session,
    snapshot: SnapshotBatch,
    expected_interval_seconds: int,
) -> dict[tuple[int, str], dict]:
    if snapshot.play_time is None:
        return {}
    rows = session.execute(
        select(
            AreaProductObservation.area_pk,
            AreaProductObservation.product_guid,
            AreaProductObservation.stock,
            SnapshotBatch.play_time,
            SnapshotBatch.snapshot_sequence,
        )
        .join(SnapshotBatch, SnapshotBatch.snapshot_id == AreaProductObservation.snapshot_id)
        .where(
            SnapshotBatch.play_session_id == snapshot.play_session_id,
            SnapshotBatch.is_complete.is_(True),
            SnapshotBatch.play_time.is_not(None),
            SnapshotBatch.snapshot_sequence <= snapshot.snapshot_sequence,
        )
        .order_by(SnapshotBatch.snapshot_sequence)
    ).all()
    points: dict[tuple[int, str], list[tuple[int, float]]] = defaultdict(list)
    for area_pk, product_guid, stock, play_time, _snapshot_sequence in rows:
        if stock is not None and play_time is not None:
            key = (area_pk, product_guid)
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
        if len(slopes) >= 3:
            value = median(slopes)
            result[key] = {
                "net_stock_change_per_minute": round(value, 3),
                "interval_count": len(slopes),
                "window_minutes": 5,
                "confidence": "measured_history",
            }
    return result


def inventory_latest(
    session: Session,
    *,
    campaign_id: str | None,
    stale_after_seconds: int,
    expected_interval_seconds: int,
) -> dict:
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
    rows = session.execute(
        select(AreaProductObservation, Area, AreaSnapshot, Product, AreaProductPolicy)
        .join(Area, Area.area_pk == AreaProductObservation.area_pk)
        .join(
            AreaSnapshot,
            and_(
                AreaSnapshot.snapshot_id == AreaProductObservation.snapshot_id,
                AreaSnapshot.area_pk == AreaProductObservation.area_pk,
            ),
        )
        .outerjoin(
            Product,
            and_(
                Product.release_id == release_id,
                Product.product_guid == AreaProductObservation.product_guid,
            ),
        )
        .outerjoin(
            AreaProductPolicy,
            and_(
                AreaProductPolicy.campaign_id == Area.campaign_id,
                AreaProductPolicy.area_pk == Area.area_pk,
                AreaProductPolicy.product_guid == AreaProductObservation.product_guid,
            ),
        )
        .where(AreaProductObservation.snapshot_id == snapshot.snapshot_id)
        .order_by(Area.latest_name, Product.name)
    ).all()

    items: list[dict[str, Any]] = []
    signals: list[dict[str, Any]] = []
    for observed, area, area_observed, product, policy in rows:
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
        eta = None
        if rate and available is not None and rate["net_stock_change_per_minute"] < 0:
            eta = available / abs(rate["net_stock_change_per_minute"])
        item = {
            "area_pk": area.area_pk,
            "area_id": area.area_id_raw,
            "area_name": area_observed.observed_name or area.latest_name or area.area_id_raw,
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
        }
        items.append(item)
        if available is not None and low_target is not None and available < low_target:
            signals.append(
                _signal("low_stock", "critical" if available <= low_target * 0.5 else "warning", item)
            )
        if fill is not None and fill >= 0.9:
            signals.append(_signal("near_full", "warning", item))
        if rate and rate["net_stock_change_per_minute"] < 0:
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
                item["velocity"]["net_stock_change_per_minute"] if item["velocity"] else None
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
    rows = session.execute(
        select(AreaProductObservation, SnapshotBatch)
        .join(SnapshotBatch, SnapshotBatch.snapshot_id == AreaProductObservation.snapshot_id)
        .where(
            AreaProductObservation.area_pk == area_pk,
            AreaProductObservation.product_guid == product_guid,
            SnapshotBatch.is_complete.is_(True),
            SnapshotBatch.play_session_id == play_session_id,
        )
        .order_by(SnapshotBatch.snapshot_sequence.desc())
        .limit(limit)
    ).all()
    return [
        {
            "snapshot_id": snapshot.snapshot_id,
            "play_session_id": snapshot.play_session_id,
            "observed_at": _iso(snapshot.completed_at or snapshot.received_at),
            "play_time": snapshot.play_time,
            "stock": observed.stock,
            "available_stock": observed.available_stock,
            "capacity": observed.storage_capacity,
        }
        for observed, snapshot in reversed(rows)
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
    rows = session.execute(
        select(AreaWorkforceObservation, Area)
        .join(Area, Area.area_pk == AreaWorkforceObservation.area_pk)
        .where(AreaWorkforceObservation.snapshot_id == snapshot.snapshot_id)
        .order_by(AreaWorkforceObservation.ordinal)
    ).all()
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
        }
        for item, area in rows
    ]


def route_issues_latest(session: Session, snapshot: SnapshotBatch | None) -> list[dict]:
    if snapshot is None:
        return []
    rows = session.scalars(
        select(TradeRouteIssueObservation)
        .where(TradeRouteIssueObservation.snapshot_id == snapshot.snapshot_id)
        .order_by(TradeRouteIssueObservation.ordinal, TradeRouteIssueObservation.issue_code)
    ).all()
    return [
        {
            "route_name": item.route_name,
            "issue_code": item.issue_code,
            "severity": item.severity,
            "active_error_count": item.active_error_count,
            "identity_scope": "ephemeral_route_name",
        }
        for item in rows
    ]


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
    chains = []
    for recipe in recipes:
        items = session.scalars(
            select(ProductionRecipeItem)
            .where(
                ProductionRecipeItem.release_id == release_id,
                ProductionRecipeItem.recipe_id == recipe.recipe_id,
            )
            .order_by(ProductionRecipeItem.role, ProductionRecipeItem.ordinal)
        ).all()
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
        chains.append(
            {
                "recipe_id": recipe.recipe_id,
                "name": recipe.name or (building.name if building else recipe.recipe_id),
                "building_guid": recipe.building_guid,
                "building_name": building.name if building else None,
                "cycle_seconds": recipe.cycle_seconds,
                "items": chain_items,
                "inferred_pressures": pressures,
                "measurement_notice": "Stock-based inferred pressure; no measured factory rate.",
            }
        )
    return {"catalog": inventory["catalog"], "chains": chains}
