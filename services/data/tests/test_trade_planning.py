from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.analytics import resolve_campaign_id, suggested_routes
from app.main import create_app
from app.models import AreaLocation, TradePlan, TradePlanItem
from app.trade_planning import ship_plan_analysis
from tests.helpers import seed_complete_snapshots


def _item(
    area_pk: int,
    product_guid: str,
    *,
    name: str,
    stock: float,
    rate: float,
    confidence: str = "stable",
    historical: bool = False,
) -> dict:
    return {
        "area_pk": area_pk,
        "area_name": "Source" if area_pk == 1 else "Destination",
        "product_guid": product_guid,
        "product_name": name,
        "available_stock": stock,
        "stock": stock,
        "capacity": 100.0,
        "low_target": 25.0,
        "high_target": 80.0,
        "priority": 2 if area_pk == 2 else 0,
        "excluded": False,
        "velocity": {
            "net_stock_change_per_minute": rate,
            "confidence": confidence,
            "is_historical": historical,
        },
    }


def _inventory(*items: dict, stale: bool = False) -> dict:
    return {
        "meta": {"is_stale": stale},
        "catalog": {"release_id": "anno117-v1-starter"},
        "items": list(items),
        "signals": [],
    }


def _commitment(session, *, plan_id: str, kind: str, amount: float, product_guid: str = "wood") -> None:
    session.add(TradePlan(
        trade_plan_id=plan_id,
        campaign_id=resolve_campaign_id(session),
        source_area_pk=1,
        destination_area_pk=2,
        status="planned",
        plan_kind=kind,
        evidence_json="{}",
    ))
    session.add(TradePlanItem(
        trade_plan_id=plan_id,
        product_guid=product_guid,
        amount=amount,
    ))
    session.flush()


def test_one_time_transfer_preserves_target_after_existing_commitments(session_factory) -> None:
    seed_complete_snapshots(session_factory)
    with session_factory() as session:
        _commitment(session, plan_id="one-time-existing", kind="emergency_transfer", amount=7)
        routes = suggested_routes(session, _inventory(
            _item(1, "wood", name="Wood", stock=100, rate=4),
            _item(2, "wood", name="Wood", stock=0, rate=-5),
        ))

        good = routes[0]["goods"][0]
        assert good["quantity_unit"] == "tons_total"
        assert good["source_committed_transfer"] == 7
        assert good["advisory_amount"] == 13
        assert good["projected_source_stock"] == good["source_protected_target"] == 80
        assert good["projected_destination_stock"] == 20


def test_recurring_rate_is_bounded_by_source_growth_commitments_and_margin(session_factory) -> None:
    seed_complete_snapshots(session_factory)
    with session_factory() as session:
        _commitment(session, plan_id="recurring-existing", kind="recurring_supply", amount=1)
        routes = suggested_routes(
            session,
            _inventory(
                _item(1, "wood", name="Wood", stock=100, rate=4),
                _item(2, "wood", name="Wood", stock=0, rate=-5),
            ),
            plan_kind="recurring_supply",
            recurring_safety_margin=0.2,
        )

        good = routes[0]["goods"][0]
        assert good["quantity_unit"] == "tons_per_minute"
        assert good["source_net_stock_change_per_minute"] == 4
        assert good["committed_export_rate_per_minute"] == 1
        assert good["safety_margin_rate_per_minute"] == 0.8
        assert good["advisory_amount"] == 2.2
        assert good["projected_source_rate_per_minute"] == 0.8
        assert good["advisory_amount"] < good["source_net_stock_change_per_minute"]


@pytest.mark.parametrize(
    ("confidence", "historical", "stale", "blocker"),
    [
        ("provisional", False, False, "source_velocity_learning"),
        ("stable", True, False, "source_velocity_historical"),
        ("stable", False, True, "source_telemetry_stale"),
    ],
)
def test_recurring_rate_stays_unquantified_without_current_stable_velocity(
    session_factory,
    confidence: str,
    historical: bool,
    stale: bool,
    blocker: str,
) -> None:
    seed_complete_snapshots(session_factory)
    with session_factory() as session:
        routes = suggested_routes(
            session,
            _inventory(
                _item(
                    1, "wood", name="Wood", stock=100, rate=4,
                    confidence=confidence, historical=historical,
                ),
                _item(2, "wood", name="Wood", stock=0, rate=-5),
                stale=stale,
            ),
            plan_kind="recurring_supply",
        )

        assert routes[0]["planning_status"] == "unsupported"
        assert routes[0]["goods"][0]["advisory_amount"] is None
        assert routes[0]["goods"][0]["blocker"] == blocker


def test_recurring_multiple_goods_are_balanced_independently(session_factory) -> None:
    seed_complete_snapshots(session_factory)
    with session_factory() as session:
        routes = suggested_routes(
            session,
            _inventory(
                _item(1, "wood", name="Wood", stock=100, rate=4),
                _item(2, "wood", name="Wood", stock=0, rate=-5),
                _item(1, "bread", name="Bread", stock=100, rate=2),
                _item(2, "bread", name="Bread", stock=0, rate=-1),
            ),
            plan_kind="recurring_supply",
            recurring_safety_margin=0.2,
        )

        goods = {item["product_guid"]: item for item in routes[0]["goods"]}
        assert goods["wood"]["advisory_amount"] == 3.2
        assert goods["bread"]["advisory_amount"] == 1
        assert goods["wood"]["projected_source_rate_per_minute"] == 0.8
        assert goods["bread"]["projected_source_rate_per_minute"] == 1


def test_negative_source_velocity_never_produces_a_recurring_quantity(session_factory) -> None:
    seed_complete_snapshots(session_factory)
    with session_factory() as session:
        routes = suggested_routes(
            session,
            _inventory(
                _item(1, "wood", name="Wood", stock=100, rate=-1),
                _item(2, "wood", name="Wood", stock=0, rate=-5),
            ),
            plan_kind="recurring_supply",
        )
        good = routes[0]["goods"][0]
        assert good["advisory_amount"] is None
        assert good["blocker"] == "source_velocity_not_positive"


def test_same_region_city_positions_provide_relative_distance_only(session_factory) -> None:
    seed_complete_snapshots(session_factory)
    with session_factory() as session:
        source_location = session.get(AreaLocation, 1) or AreaLocation(area_pk=1)
        destination_location = session.get(AreaLocation, 2) or AreaLocation(area_pk=2)
        source_location.manual_region_guid = destination_location.manual_region_guid = "3225"
        source_location.manual_x = source_location.manual_y = 0
        destination_location.manual_x = 0.3
        destination_location.manual_y = 0.4
        session.add_all([source_location, destination_location])
        session.flush()
        routes = suggested_routes(session, _inventory(
            _item(1, "wood", name="Wood", stock=100, rate=4),
            _item(2, "wood", name="Wood", stock=0, rate=-5),
        ))
        assert routes[0]["route_distance"]["value"] == 0.5
        assert routes[0]["route_distance"]["unit"] == "relative_map_distance"
        assert "not travel time" in routes[0]["route_distance"]["limitation"]


def test_ship_analysis_respects_50t_slots_round_trip_and_user_ship_cost() -> None:
    analysis = ship_plan_analysis(
        [4, 1],
        plan_kind="recurring_supply",
        cargo_slots=2,
        expected_round_trip_minutes=20,
        ship_cost=1_000,
    )
    assert analysis["target_amounts_per_cycle"] == [80, 20]
    assert analysis["slots_by_good"] == [2, 1]
    assert analysis["estimated_required_ships"] == 2
    assert analysis["estimated_fleet_cost"] == 2_000

    missing_time = ship_plan_analysis(
        [4],
        plan_kind="recurring_supply",
        cargo_slots=3,
        expected_round_trip_minutes=None,
        ship_cost=1_000,
    )
    assert missing_time["estimated_required_ships"] is None
    assert missing_time["capacity_basis"] == "missing_round_trip_time"

    missing_capacity = ship_plan_analysis(
        [4],
        plan_kind="recurring_supply",
        cargo_slots=None,
        expected_round_trip_minutes=10,
        ship_cost=1_000,
    )
    assert missing_capacity["estimated_required_ships"] is None
    assert missing_capacity["capacity_basis"] == "unknown"


def test_one_time_ship_slots_do_not_mix_unlike_goods() -> None:
    analysis = ship_plan_analysis(
        [20, 20, 60],
        plan_kind="emergency_transfer",
        cargo_slots=3,
        expected_round_trip_minutes=None,
        ship_cost=500,
    )
    assert analysis["slots_by_good"] == [1, 1, 2]
    assert analysis["total_slots_required"] == 4
    assert analysis["estimated_required_ships"] == 2
    assert analysis["estimated_fleet_cost"] == 1_000


def test_saving_typed_recommendation_persists_ship_assumptions_and_rejects_stale_reuse(
    session_factory,
    app_settings,
) -> None:
    seed_complete_snapshots(session_factory)
    with TestClient(create_app(app_settings, session_factory)) as client:
        response = client.get("/api/v1/trade/opportunities")
        route = response.json()["suggested_routes"][0]
        payload = {
            "source_area_pk": route["source_area_pk"],
            "destination_area_pk": route["destination_area_pk"],
            "plan_kind": route["plan_kind"],
            "goods": [
                {"product_guid": item["product_guid"], "amount": item["advisory_amount"]}
                for item in route["goods"] if item["advisory_amount"] is not None
            ],
            "cargo_slots": 3,
            "usable_ship_capacity": 150,
            "ship_cost": 1_000,
            "reason": route["reason"],
            "evidence": route["evidence"],
        }
        saved = client.post("/api/v1/trade-plans", json=payload)
        assert saved.status_code == 200
        assert saved.json()["quantity_unit"] == "tons_total"
        assert saved.json()["cargo_slots"] == 3
        assert saved.json()["cargo_slot_capacity"] == 50
        assert saved.json()["estimated_required_ships"] == 1
        assert saved.json()["estimated_fleet_cost"] == 1_000

        stale = client.post("/api/v1/trade-plans", json=payload)
        assert stale.status_code == 409
        assert "recalculate" in stale.json()["detail"]
