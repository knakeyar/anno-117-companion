from __future__ import annotations

import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.advisor import AdvisorStructured, ask_advisor
from app.analytics import finance_analysis, latest_complete_snapshot
from app.catalog import catalog_summary, load_catalog
from app.ingestion import PRODUCTION_PREFIX, TelemetryIngestor
from app.main import create_app
from app.models import (
    AdvisorMessage,
    ActiveTradeRouteCurrent,
    AreaBuildingCurrent,
    AreaProductCurrent,
    AreaProductObservation,
    AreaSnapshot,
    Campaign,
    ManagementAction,
    PlaySession,
    SnapshotBatch,
    TradeRouteIssueObservation,
)

from .helpers import seed_complete_snapshots


def test_pinned_catalog_has_exact_community_coverage(session_factory) -> None:
    path = Path(__file__).resolve().parents[3] / "catalog" / "anno117-community-2.1-c6a6e752.json"
    with session_factory() as session:
        release = load_catalog(session, path)
        summary = catalog_summary(session, release.release_id)
        assert summary["products"] == 145
        assert summary["telemetry_products"] == 113
        assert summary["factories"] == 144
        assert summary["coverage"] == "complete"
        assert summary["source_revision"] == "c6a6e7525d16927f74d4f554dde5831b84fa287c"


def test_estimated_base_maintenance_uses_city_factory_counts(session_factory) -> None:
    seed_complete_snapshots(session_factory)
    path = Path(__file__).resolve().parents[3] / "catalog" / "anno117-community-2.1-c6a6e752.json"
    with session_factory() as session:
        load_catalog(session, path)
        play = session.scalar(select(PlaySession))
        snapshot = latest_complete_snapshot(session, play.campaign_id)
        play.static_release_id = "anno117-community-2.1-c6a6e752"
        session.add(AreaBuildingCurrent(
            area_pk=1,
            building_guid="2955",
            campaign_id=play.campaign_id,
            play_session_id=play.play_session_id,
            snapshot_id=snapshot.snapshot_id,
            building_count=2,
            presence_status="installed",
            observed_at=snapshot.completed_at,
        ))
        session.flush()
        analysis = finance_analysis(session, snapshot)
        assert analysis["category_totals"] == {
            "gross_income": 300.0,
            "gross_expenses": 100.0,
            "net_profit": 200.0,
            "interpretation": "sum_of_observed_finance_categories",
        }
        assert analysis["estimated_base_maintenance"]["total"] == 12
        assert analysis["estimated_base_maintenance"]["cities"][0]["area_name"] == "Juliana"
        assert analysis["estimated_base_maintenance"]["notice"].startswith("Estimated base maintenance")


def test_legacy_engine_route_error_15_is_explained(session_factory, app_settings) -> None:
    seed_complete_snapshots(session_factory)
    with session_factory() as session:
        snapshot = latest_complete_snapshot(session)
        session.add(TradeRouteIssueObservation(
            snapshot_id=snapshot.snapshot_id,
            ordinal=2,
            route_name="Bread Cud - Rhy",
            issue_code="engine_error_15",
            severity="warning",
            active_error_count=1,
            raw_flags_json='{"active_error_types":[15]}',
        ))
        session.commit()
    app = create_app(app_settings, session_factory)
    with TestClient(app) as client:
        issues = client.get("/api/v1/dashboard/overview").json()["route_issues"]
        issue = next(item for item in issues if item["route_name"] == "Bread Cud - Rhy")
        assert issue["issue_code"] == "mismatching_good"
        assert issue["engine_error_code"] == 15
        assert issue["label"] == "Mismatching cargo"
        assert "matching unload" in issue["guidance"]


def _v2(event_type: str, sequence: int, snapshot: int | None, data: dict, *, ok: bool = True) -> str:
    payload = {
        "schema_version": 2, "mod_version": "1.1.0", "catalog_release": "anno117-v1-starter",
        "catalog_hash": "fixture-v2", "event_type": event_type, "sequence": sequence,
        "load_epoch": 7, "snapshot_sequence": snapshot, "ok": ok, "data": data,
    }
    return f"[SCRIPT] {PRODUCTION_PREFIX}{json.dumps(payload)}\n"


def test_v2_baseline_delta_and_incomplete_batch_are_atomic(session_factory) -> None:
    ingestor = TelemetryIngestor(session_factory)
    offset = 0
    sequence = 0

    def ingest(event: str, snapshot: int | None, data: dict, ok: bool = True) -> None:
        nonlocal offset, sequence
        sequence += 1
        line = _v2(event, sequence, snapshot, data, ok=ok)
        ingestor.ingest_line(source_path="v2.log", source_fingerprint="v2:1", source_offset=offset, line=line)
        offset += len(line.encode())

    ingest("telemetry_loaded", None, {})

    def batch(snapshot: int, stock: float, *, mode: str, complete: bool = True) -> None:
        ingest("snapshot_started", snapshot, {"section_mode": mode, "context": {"participant_guid": "41", "game_seed": "951", "play_time": snapshot * 30_000}, "area_enumeration_scope": "all_controlled_areas", "area_count": 1})
        ingest("area_core", snapshot, {"area_id": "100", "CityName": "Roma", "location": {"status": "success", "x": 1200, "y": 400, "session_guid": "3245", "region_guid": "3225"}})
        ingest("area_inventory_chunk", snapshot, {"area_id": "100", "chunk_index": 1, "chunk_count": 1, "attempted_count": 1, "products": [{"product_guid": "2174", "stock": stock, "available": stock, "capacity": 100, "reserved": 0}]})
        ingest("area_building_chunk", snapshot, {"area_id": "100", "chunk_index": 1, "chunk_count": 1, "attempted_count": 1, "buildings": [{"building_guid": "fixture-building", "count": 2 if snapshot == 1 else 0}]})
        ingest("area_completed", snapshot, {"area_id": "100", "inventory": {"status": "success", "attempted_count": 1, "captured_count": 1}, "buildings": {"status": "success", "attempted_count": 1, "captured_count": 1}})
        ingest("snapshot_completed", snapshot, {"complete": complete, "expected_area_count": 1, "emitted_area_count": 1})

    batch(1, 50, mode="baseline")
    batch(2, 40, mode="delta", complete=False)
    with session_factory() as session:
        current = session.get(AreaProductCurrent, (1, "2174"))
        assert current is not None and current.stock == 50
        assert session.scalar(select(func.count()).select_from(SnapshotBatch).where(SnapshotBatch.is_complete)) == 1
        building = session.get(AreaBuildingCurrent, (1, "fixture-building"))
        assert building is not None and building.building_count == 2


def test_v2_unchanged_goods_gain_provisional_then_stable_zero_velocity(
    session_factory, app_settings
) -> None:
    ingestor = TelemetryIngestor(session_factory)
    offset = 0
    sequence = 0

    def ingest(event: str, snapshot: int | None, data: dict) -> None:
        nonlocal offset, sequence
        sequence += 1
        line = _v2(event, sequence, snapshot, data)
        ingestor.ingest_line(
            source_path="dense.log",
            source_fingerprint="dense:1",
            source_offset=offset,
            line=line,
        )
        offset += len(line.encode())

    ingest("telemetry_loaded", None, {})

    def batch(snapshot: int, *, baseline: bool) -> None:
        products = (
            [{"product_guid": "2174", "stock": 50, "available": 50, "capacity": 100}]
            if baseline
            else []
        )
        ingest("snapshot_started", snapshot, {
            "section_mode": "baseline" if baseline else "delta",
            "context": {
                "participant_guid": "41", "game_seed": "951",
                "play_time": snapshot * 30_000,
            },
            "area_enumeration_scope": "all_controlled_areas", "area_count": 1,
        })
        ingest("area_core", snapshot, {"area_id": "100", "CityName": "Roma"})
        ingest("area_inventory_chunk", snapshot, {
            "area_id": "100", "chunk_index": 1, "chunk_count": 1,
            "attempted_count": 1, "products": products,
        })
        ingest("area_building_chunk", snapshot, {
            "area_id": "100", "chunk_index": 1, "chunk_count": 1,
            "attempted_count": 0, "buildings": [],
        })
        ingest("area_completed", snapshot, {
            "area_id": "100",
            "inventory": {
                "status": "success", "attempted_count": 1,
                "captured_count": len(products), "chunk_count": 1,
            },
            "buildings": {
                "status": "success", "attempted_count": 0,
                "captured_count": 0, "chunk_count": 1,
            },
        })
        ingest("snapshot_completed", snapshot, {
            "complete": True, "expected_area_count": 1, "emitted_area_count": 1,
        })

    batch(1, baseline=True)
    batch(2, baseline=False)
    app = create_app(app_settings, session_factory)
    with TestClient(app) as client:
        velocity = client.get("/api/v1/inventory/latest").json()["items"][0]["velocity"]
        assert velocity["net_stock_change_per_minute"] == 0
        assert velocity["interval_count"] == 1
        assert velocity["confidence"] == "provisional"

    batch(3, baseline=False)
    batch(4, baseline=False)
    with TestClient(app) as client:
        inventory = client.get("/api/v1/inventory/latest").json()
        velocity = inventory["items"][0]["velocity"]
        assert velocity["net_stock_change_per_minute"] == 0
        assert velocity["interval_count"] == 3
        assert velocity["confidence"] == "stable"
        area_pk = inventory["items"][0]["area_pk"]
        history = client.get(
            "/api/v1/inventory/history",
            params={"area_pk": area_pk, "product_guid": "2174"},
        ).json()["items"]
        assert [point["sample_kind"] for point in history] == [
            "observed", "carried_forward", "carried_forward", "carried_forward"
        ]

    with session_factory() as session:
        # The transport history remains sparse: only the baseline changed row
        # is stored even though the API exposes four proven stock samples.
        assert session.scalar(select(func.count()).select_from(AreaProductObservation)) == 1


def test_new_play_session_uses_previous_rate_until_first_interval(
    session_factory, app_settings
) -> None:
    seed_complete_snapshots(session_factory)
    with session_factory() as session:
        previous = session.scalar(select(PlaySession).where(PlaySession.is_current.is_(True)))
        assert previous is not None and previous.campaign_id is not None
        previous.is_current = False
        previous.ended_at = datetime.now(UTC)
        current = PlaySession(
            play_session_id="new-session",
            campaign_id=previous.campaign_id,
            static_release_id=previous.static_release_id,
            transport_key="new-transport",
            load_epoch=2,
            started_at=previous.started_at + timedelta(hours=1),
            is_current=True,
        )
        session.add(current)
        campaign_id = previous.campaign_id
        session.commit()

    app = create_app(app_settings, session_factory)
    with TestClient(app) as client:
        velocities = [
            item["velocity"] for item in client.get("/api/v1/inventory/latest").json()["items"]
        ]
        assert all(velocity["confidence"] == "previous_session" for velocity in velocities)
        assert all(velocity["is_historical"] is True for velocity in velocities)

    with session_factory() as session:
        current = session.get(PlaySession, "new-session")
        assert current is not None
        snapshot = SnapshotBatch(
            play_session_id=current.play_session_id,
            snapshot_sequence=1,
            received_at=datetime.now(UTC),
            completed_at=datetime.now(UTC),
            play_time=2_000_000,
            area_enumeration_scope="all_controlled_areas",
            expected_area_count=2,
            emitted_area_count=2,
            is_complete=True,
            normalization_status="complete",
            section_mode="baseline",
        )
        session.add(snapshot)
        session.flush()
        current_rows = session.scalars(
            select(AreaProductCurrent).where(
                AreaProductCurrent.campaign_id == campaign_id
            )
        ).all()
        for row in current_rows:
            session.add(AreaSnapshot(snapshot_id=snapshot.snapshot_id, area_pk=row.area_pk))
        session.flush()
        for row in current_rows:
            row.play_session_id = current.play_session_id
            row.snapshot_id = snapshot.snapshot_id
            session.add(AreaProductObservation(
                snapshot_id=snapshot.snapshot_id,
                area_pk=row.area_pk,
                product_guid=row.product_guid,
                stock=row.stock,
                available_stock=row.available_stock,
                storage_capacity=row.storage_capacity,
            ))
        session.commit()

    with TestClient(app) as client:
        velocities = [
            item["velocity"] for item in client.get("/api/v1/inventory/latest").json()["items"]
        ]
        assert all(velocity["confidence"] == "previous_session" for velocity in velocities)
        assert all(velocity["is_historical"] is True for velocity in velocities)


def test_v2_missing_chunk_never_becomes_current(session_factory) -> None:
    ingestor = TelemetryIngestor(session_factory)
    lines = [
        _v2("telemetry_loaded", 1, None, {}),
        _v2("snapshot_started", 2, 1, {"section_mode": "baseline", "context": {"participant_guid": "41", "game_seed": "951", "play_time": 30_000}, "area_enumeration_scope": "all_controlled_areas", "area_count": 1}),
        _v2("area_core", 3, 1, {"area_id": "100", "CityName": "Roma", "location": {"status": "not_observed"}}),
        _v2("area_inventory_chunk", 4, 1, {"area_id": "100", "chunk_index": 1, "chunk_count": 2, "attempted_count": 2, "products": [{"product_guid": "2174", "stock": 50}]}),
        _v2("area_building_chunk", 5, 1, {"area_id": "100", "chunk_index": 1, "chunk_count": 1, "attempted_count": 1, "buildings": []}),
        _v2("area_completed", 6, 1, {"area_id": "100", "inventory": {"status": "success", "attempted_count": 2, "captured_count": 1, "chunk_count": 2}, "buildings": {"status": "success", "attempted_count": 1, "captured_count": 0, "chunk_count": 1}}),
        _v2("snapshot_completed", 7, 1, {"complete": True, "expected_area_count": 1, "emitted_area_count": 1}),
    ]
    offset = 0
    for line in lines:
        ingestor.ingest_line(source_path="missing.log", source_fingerprint="missing:1", source_offset=offset, line=line)
        offset += len(line.encode())
    with session_factory() as session:
        snapshot = session.scalar(select(SnapshotBatch))
        assert snapshot.is_complete is False
        assert session.scalar(select(func.count()).select_from(AreaProductCurrent)) == 0


def test_ship_backed_routes_are_persisted_and_failed_scans_preserve_them(session_factory, app_settings) -> None:
    ingestor = TelemetryIngestor(session_factory)
    offset = 0
    sequence = 0

    def ingest(event: str, snapshot: int | None, data: dict) -> None:
        nonlocal offset, sequence
        sequence += 1
        line = _v2(event, sequence, snapshot, data)
        ingestor.ingest_line(
            source_path="routes.log", source_fingerprint="routes:1", source_offset=offset, line=line
        )
        offset += len(line.encode())

    ingest("telemetry_loaded", None, {})
    ingest("snapshot_started", 1, {
        "section_mode": "baseline",
        "context": {
            "participant_guid": "41", "game_seed": "951", "play_time": 30_000,
            "game_session_guid": "3245", "region_guid": "3225",
        },
        "area_enumeration_scope": "all_controlled_areas", "area_count": 0,
    })
    ingest("participant_snapshot", 1, {
        "finance": {"participant_guid": "41", "money": {}},
        "route_issues": {"items": []},
        "route_ships": {
            "status": "success", "reported_count": 3, "assigned_count": 2,
            "items": [
                {"ship_id": "8121", "ship_name": "Mercury", "ship_guid": "37222", "game_session_guid": "3245", "area_id": "8513", "route_name": "Olives Rav - Jul", "is_paused": False, "on_regular_route": True, "loading_speed_factor": 1.0},
                {"ship_id": "8122", "ship_name": "Fortuna", "ship_guid": "37223", "game_session_guid": "3245", "area_id": "8513", "route_name": "Olives Rav - Jul", "is_paused": True, "on_regular_route": True, "loading_speed_factor": 1.2},
            ],
        },
    })
    ingest("snapshot_completed", 1, {"complete": True, "expected_area_count": 0, "emitted_area_count": 0})

    # An unavailable later scan is explicitly not-observed and must not erase
    # the prior route evidence.
    ingest("snapshot_started", 2, {
        "section_mode": "delta",
        "context": {
            "participant_guid": "41", "game_seed": "951", "play_time": 60_000,
            "game_session_guid": "3245", "region_guid": "3225",
        },
        "area_enumeration_scope": "all_controlled_areas", "area_count": 0,
    })
    ingest("participant_snapshot", 2, {
        "finance": {"participant_guid": "41", "money": {}},
        "route_issues": {"items": []},
        "route_ships": {"status": "not_observed", "items": [], "error": "binding unavailable"},
    })
    ingest("snapshot_completed", 2, {"complete": True, "expected_area_count": 0, "emitted_area_count": 0})
    ingest("telemetry_unloaded", None, {})

    with session_factory() as session:
        route = session.scalar(select(ActiveTradeRouteCurrent))
        assert route is not None
        assert route.route_name == "Olives Rav - Jul"
        assert route.assigned_ship_count == 2
        assert route.paused_ship_count == 1
        assert route.is_active is True

    app = create_app(app_settings, session_factory)
    with TestClient(app) as client:
        response = client.get("/api/v1/trade/routes")
        assert response.status_code == 200
        payload = response.json()
        assert payload["telemetry_status"] == "not_observed"
        assert payload["counts"] == {
            "ship_backed_routes": 1, "issue_only_routes": 0, "assigned_ships": 2,
        }
        route = payload["items"][0]
        assert route["status"] == "partially_paused"
        assert route["evidence_kind"] == "assigned_ships"
        assert len(route["ships"]) == 2
        assert [ship["ship_name"] for ship in route["ships"]] == ["Mercury", "Fortuna"]
        assert payload["capabilities"]["stops"] is False


def test_unload_and_restart_keep_campaign_areas_and_inventory(session_factory, app_settings) -> None:
    seed_complete_snapshots(session_factory)
    ingestor = TelemetryIngestor(session_factory)
    line = _v2("telemetry_unloaded", 999, None, {})
    ingestor.ingest_line(source_path="fixture.log", source_fingerprint="fixture:1", source_offset=999_000, line=line)
    app = create_app(app_settings, session_factory)
    with TestClient(app) as client:
        status = client.get("/api/v1/status").json()
        assert status["play_session"] is None
        assert len(client.get("/api/v1/areas").json()["items"]) == 2
        assert len(client.get("/api/v1/inventory/latest").json()["items"]) == 2


def test_trade_plan_action_map_and_advisor_fallback_apis(session_factory, app_settings) -> None:
    seed_complete_snapshots(session_factory)
    app = create_app(app_settings, session_factory)
    with TestClient(app) as client:
        overview = client.get("/api/v1/dashboard/overview").json()
        assert overview["actions"]
        assert overview["suggested_routes"]
        route = overview["suggested_routes"][0]
        campaign_id = client.get("/api/v1/areas").json()["campaign_id"]
        response = client.post("/api/v1/trade-plans", json={"campaign_id": campaign_id, "source_area_pk": route["source_area_pk"], "destination_area_pk": route["destination_area_pk"], "goods": [{"product_guid": item["product_guid"], "amount": item["advisory_amount"]} for item in route["goods"]]})
        assert response.status_code == 200 and response.json()["status"] == "planned"
        opportunities = client.get("/api/v1/trade/opportunities").json()
        assert all(item["suggestion_id"] != route["suggestion_id"] for item in opportunities["suggested_routes"])
        actions = client.get("/api/v1/actions").json()["items"]
        assert any(item["kind"] == "route_capacity" for item in actions)
        area = client.get("/api/v1/areas").json()["items"][0]
        placed = client.put(f"/api/v1/areas/{area['area_pk']}/map-position", json={"region_guid": "3225", "x": .2, "y": .3, "clear": False})
        assert placed.json()["position_source"] == "manual"
        advisor = client.post("/api/v1/advisor/messages", json={"question": "What should I do first?"}).json()
        assert advisor["available"] is False
        assert "not configured" in advisor["error"]


def test_advisor_uses_store_false_compact_context_and_rejects_unknown_actions(session_factory, app_settings) -> None:
    with session_factory() as session:
        campaign = Campaign(campaign_id="advisor-campaign", display_name="Advisor", identity_key="advisor", identity_method="test", identity_confidence="test")
        session.add(campaign)
        session.add(ManagementAction(action_id="act_known", campaign_id=campaign.campaign_id, kind="stock", severity="warning", title="Known", summary="Known action", evidence_json="{}"))
        session.commit()

        calls = []
        class Responses:
            def parse(self, **kwargs):
                calls.append(kwargs)
                return SimpleNamespace(output_parsed=AdvisorStructured(answer="Move the verified good.", referenced_action_ids=["act_known", "act_fake"]))
        result = ask_advisor(
            session,
            replace(app_settings, openai_api_key="test-key"),
            campaign_id=campaign.campaign_id,
            question="What now?",
            compact_context={"actions": [{"action_id": "act_known"}]},
            client=SimpleNamespace(responses=Responses()),
        )
        assert result["available"] is True
        assert calls[0]["store"] is False
        assert "tools" not in calls[0]
        assistant = session.scalar(select(AdvisorMessage).where(AdvisorMessage.role == "assistant"))
        assert json.loads(assistant.action_ids_json) == ["act_known"]
