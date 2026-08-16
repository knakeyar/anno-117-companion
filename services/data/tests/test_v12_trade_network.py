from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.analytics import latest_complete_snapshot
from app.main import create_app
from app.models import (
    ActiveTradeRouteCurrent,
    ActiveTradeRouteShipCurrent,
    Area,
    PlaySession,
    TradePlan,
    TradeRouteLink,
    utcnow,
)

from .helpers import seed_complete_snapshots


def _route(
    *,
    key: str,
    name: str,
    campaign_id: str,
    play_session_id: str,
    snapshot_id: int,
    paused: int = 0,
    ships: int = 1,
) -> ActiveTradeRouteCurrent:
    now = utcnow()
    return ActiveTradeRouteCurrent(
        route_key=key,
        campaign_id=campaign_id,
        route_name=name,
        game_session_guid="3245",
        region_guid="3225",
        play_session_id=play_session_id,
        snapshot_id=snapshot_id,
        assigned_ship_count=ships,
        paused_ship_count=paused,
        regular_ship_count=ships,
        is_active=True,
        first_seen_at=now,
        last_seen_at=now,
    )


def _ship(route_key: str, ship_id: str, *, paused: bool, name: str) -> ActiveTradeRouteShipCurrent:
    return ActiveTradeRouteShipCurrent(
        route_key=route_key,
        ship_id_raw=ship_id,
        ship_name=name,
        ship_guid="37222",
        owner_guid="41",
        game_session_guid="3245",
        area_id_raw="8513",
        is_paused=paused,
        on_regular_route=True,
        loading_speed_factor=1.0,
        observed_at=utcnow(),
    )


def test_exact_tag_detection_aggregates_route_ships_and_planned_goods(session_factory, app_settings) -> None:
    seed_complete_snapshots(session_factory)
    app = create_app(app_settings, session_factory)
    with TestClient(app) as client:
        suggestion = client.get("/api/v1/trade/opportunities").json()["suggested_routes"][0]
        created = client.post("/api/v1/trade-plans", json={
            "campaign_id": client.get("/api/v1/areas").json()["campaign_id"],
            "source_area_pk": suggestion["source_area_pk"],
            "destination_area_pk": suggestion["destination_area_pk"],
            "plan_kind": "recurring_supply",
            "goods": [{
                "product_guid": good["product_guid"],
                "amount": good["advisory_amount"],
            } for good in suggestion["goods"]],
        }).json()

        with session_factory() as session:
            play = session.scalar(select(PlaySession).where(PlaySession.is_current.is_(True)))
            snapshot = latest_complete_snapshot(session, play.campaign_id)
            naissus = session.get(Area, 2)
            naissus.confirmed_region_guid = "3225"
            naissus.confirmed_game_session_guid = "3245"
            naissus.region_evidence = "test"
            session.add(Area(
                campaign_id=play.campaign_id,
                area_id_raw="8451",
                latest_name="Cudslip",
                confirmed_region_guid="6626",
                confirmed_game_session_guid="6569",
                region_evidence="test",
            ))
            session.add(_route(
                key="tagged-route", name=created["suggested_route_name"], campaign_id=play.campaign_id,
                play_session_id=play.play_session_id, snapshot_id=snapshot.snapshot_id, paused=1, ships=2,
            ))
            session.add_all([
                _ship("tagged-route", "8121", paused=False, name="Mercury"),
                _ship("tagged-route", "8122", paused=True, name="Fortuna"),
            ])
            session.add(_route(
                key="unmapped-route", name="Bread Cud - Rhy", campaign_id=play.campaign_id,
                play_session_id=play.play_session_id, snapshot_id=snapshot.snapshot_id,
            ))
            session.add(_ship("unmapped-route", "9001", paused=False, name="Minerva"))
            session.commit()

        network = client.get("/api/v1/trade/network").json()
        assert len(network["graphs"]["cross_region"]["nodes"]) == 3
        edge = network["graphs"]["latium"]["edges"][0]
        assert edge["status"] == "partially_paused"
        assert edge["severity"] == "critical"
        assert edge["summary"] == {"goods": 1, "routes": 1, "ships": 2, "plans": 1}
        assert {ship["ship_name"] for ship in edge["ships"]} == {"Mercury", "Fortuna"}
        assert edge["planned_goods"][0]["evidence_kind"] == "planned"
        assert edge["configured_goods"] == [] and edge["cargo_aboard"] == []
        assert any(item["route_name"] == "Bread Cud - Rhy" for item in network["unmapped_routes"])
        naissus_node = next(item for item in network["graphs"]["latium"]["nodes"] if item["area_name"] == "Naissus")
        assert naissus_node["important_goods"][0]["product_name"] == "Timber"
        assert naissus_node["pressure_signals"][0]["severity"] == "critical"

        plan = client.get("/api/v1/trade-plans").json()["items"][0]
        assert plan["status"] == "implemented"
        assert plan["runtime_status"] == "partially_paused"
        assert plan["route_tag"].startswith("AC-")
        assert plan["route_tag"] in plan["suggested_route_name"]


def test_manual_link_moves_an_opaque_route_into_cross_region_graph_and_unlinks(session_factory, app_settings) -> None:
    seed_complete_snapshots(session_factory)
    with session_factory() as session:
        play = session.scalar(select(PlaySession).where(PlaySession.is_current.is_(True)))
        snapshot = latest_complete_snapshot(session, play.campaign_id)
        albion = Area(
            campaign_id=play.campaign_id,
            area_id_raw="8451",
            latest_name="Cudslip",
            confirmed_region_guid="6626",
            confirmed_game_session_guid="6569",
            region_evidence="test",
        )
        session.add(albion)
        session.flush()
        session.add(_route(
            key="opaque-route", name="Bread Cud - Rhy", campaign_id=play.campaign_id,
            play_session_id=play.play_session_id, snapshot_id=snapshot.snapshot_id,
        ))
        session.add(_ship("opaque-route", "9001", paused=False, name="Minerva"))
        campaign_id = play.campaign_id
        destination_pk = albion.area_pk
        session.commit()

    app = create_app(app_settings, session_factory)
    with TestClient(app) as client:
        assert any(item["route_key"] == "opaque-route" for item in client.get("/api/v1/trade/network").json()["unmapped_routes"])
        plan = client.post("/api/v1/trade-plans", json={
            "campaign_id": campaign_id,
            "source_area_pk": 1,
            "destination_area_pk": destination_pk,
            "goods": [{"product_guid": "2174", "amount": 10}],
        }).json()
        linked = client.post("/api/v1/trade/route-links", json={
            "campaign_id": campaign_id,
            "route_key": "opaque-route",
            "source_area_pk": 1,
            "destination_area_pk": destination_pk,
            "trade_plan_id": plan["trade_plan_id"],
        })
        assert linked.status_code == 200
        link = linked.json()
        assert link["link_method"] == "manual"
        detached = client.patch(
            f"/api/v1/trade/route-links/{link['link_id']}",
            json={"trade_plan_id": None},
        )
        assert detached.status_code == 200 and detached.json()["trade_plan_id"] is None
        network = client.get("/api/v1/trade/network").json()
        assert len(network["graphs"]["cross_region"]["edges"]) == 1
        assert not any(item["route_key"] == "opaque-route" for item in network["unmapped_routes"])

        with session_factory() as session:
            old_route = session.get(ActiveTradeRouteCurrent, "opaque-route")
            old_route.is_active = False
            play = session.scalar(select(PlaySession).where(PlaySession.is_current.is_(True)))
            snapshot = latest_complete_snapshot(session, play.campaign_id)
            session.add(_route(
                key="renamed-route", name="Renamed Supply", campaign_id=play.campaign_id,
                play_session_id=play.play_session_id, snapshot_id=snapshot.snapshot_id,
            ))
            session.add(_ship("renamed-route", "9001", paused=False, name="Minerva"))
            session.commit()
        renamed = client.get("/api/v1/trade/network").json()
        candidate = next(item for item in renamed["unmapped_routes"] if item["route_key"] == "renamed-route")
        assert candidate["relink_suggestions"][0]["overlapping_ship_ids"] == ["9001"]
        confirmed = client.patch(f"/api/v1/trade/route-links/{link['link_id']}", json={"route_key": "renamed-route"})
        assert confirmed.status_code == 200
        assert confirmed.json()["route_name"] == "Renamed Supply"

        assert client.delete(f"/api/v1/trade/route-links/{link['link_id']}").status_code == 204
        assert any(item["route_key"] == "renamed-route" for item in client.get("/api/v1/trade/network").json()["unmapped_routes"])


def test_duplicate_exact_tags_become_ambiguous_and_unloaded_routes_are_historical(session_factory, app_settings) -> None:
    seed_complete_snapshots(session_factory)
    app = create_app(app_settings, session_factory)
    with TestClient(app) as client:
        suggestion = client.get("/api/v1/trade/opportunities").json()["suggested_routes"][0]
        plan = client.post("/api/v1/trade-plans", json={
            "source_area_pk": suggestion["source_area_pk"],
            "destination_area_pk": suggestion["destination_area_pk"],
            "goods": [{"product_guid": suggestion["goods"][0]["product_guid"], "amount": 5}],
        }).json()
        with session_factory() as session:
            play = session.scalar(select(PlaySession).where(PlaySession.is_current.is_(True)))
            snapshot = latest_complete_snapshot(session, play.campaign_id)
            for key, suffix in (("route-a", "Jul-Nai"), ("route-b", "Jul-Nai")):
                session.add(_route(
                    key=key, name=f"{plan['route_tag']} {suffix}", campaign_id=play.campaign_id,
                    play_session_id=play.play_session_id, snapshot_id=snapshot.snapshot_id,
                ))
                session.add(_ship(key, f"ship-{key}", paused=False, name=suffix))
            session.commit()

        current = client.get("/api/v1/trade-plans").json()["items"][0]
        assert current["runtime_status"] == "ambiguous"
        with session_factory() as session:
            assert session.scalar(select(TradeRouteLink).where(TradeRouteLink.trade_plan_id == plan["trade_plan_id"])) is None
            stored = session.get(TradePlan, plan["trade_plan_id"])
            play = session.scalar(select(PlaySession).where(PlaySession.is_current.is_(True)))
            play.is_current = False
            play.ended_at = utcnow()
            session.commit()
            assert stored.runtime_status == "ambiguous"

        network = client.get("/api/v1/trade/network").json()
        assert all(route["freshness"] == "historical" for route in network["unmapped_routes"] if route["route_key"] in {"route-a", "route-b"})
