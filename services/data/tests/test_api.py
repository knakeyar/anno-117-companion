from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.ingestion import TelemetryIngestor
from app.main import create_app
from app.models import (
    Area,
    AreaPopulationObservation,
    AreaProductObservation,
    BuildingType,
    Campaign,
    ParticipantFinanceObservation,
    PlaySession,
    ProductionRecipe,
    ProductionRecipeItem,
    SnapshotBatch,
)

from .helpers import envelope, seed_complete_snapshots


def test_complete_snapshot_drives_management_api(session_factory, app_settings) -> None:
    seed_complete_snapshots(session_factory)
    app = create_app(app_settings, session_factory)
    with TestClient(app) as client:
        inventory = client.get("/api/v1/inventory/latest").json()
        assert inventory["meta"]["scope"] == "all_controlled_areas"
        assert inventory["meta"]["is_stale"] is False
        assert len(inventory["items"]) == 2
        assert all(item["velocity"]["interval_count"] == 3 for item in inventory["items"])
        assert all("net_stock_change_per_minute" in item["velocity"] for item in inventory["items"])
        assert not any("production_rate" in item for item in inventory["items"])

        opportunities = client.get("/api/v1/trade/opportunities").json()
        assert opportunities["items"] == [
            {
                "product_guid": "2174",
                "product_name": "Timber",
                "source_area_pk": inventory["items"][0]["area_pk"],
                "source_area_name": "Juliana",
                "destination_area_pk": inventory["items"][1]["area_pk"],
                "destination_area_name": "Naissus",
                "advisory_amount": 5.0,
                "destination_priority": 0,
                "route_feasibility": "unknown",
                "interpretation": "transfer_candidate",
            }
        ]

        overview = client.get("/api/v1/dashboard/overview").json()
        assert overview["finance"]["treasury"] == 3_756_154
        assert overview["route_issues"][0]["issue_code"] == "no_ships"
        assert overview["workforce_shortages"][0]["scope"] == "current_camera_area"
        assert overview["language"]["rate_label"] == "Net stock change"

        chains = client.get("/api/v1/production/chains").json()
        assert chains["catalog"]["coverage"] == "starter"
        assert chains["chains"] == []


def test_policies_override_targets_and_validate_area_ownership(session_factory, app_settings) -> None:
    seed_complete_snapshots(session_factory)
    app = create_app(app_settings, session_factory)
    with TestClient(app) as client:
        campaigns = client.get("/api/v1/campaigns").json()
        campaign_id = campaigns[0]["campaign_id"]
        areas = client.get("/api/v1/areas").json()["items"]
        juliana = next(area for area in areas if area["name"] == "Juliana")
        response = client.put(
            "/api/v1/policies",
            json={
                "campaign_id": campaign_id,
                "area_pk": juliana["area_pk"],
                "product_guid": "2174",
                "low_target": 35,
                "high_target": 90,
                "priority": 4,
                "excluded": False,
            },
        )
        assert response.status_code == 200
        item = next(
            item
            for item in client.get("/api/v1/inventory/latest").json()["items"]
            if item["area_name"] == "Juliana"
        )
        assert item["low_target"] == 35
        assert item["high_target"] == 90
        assert item["policy_source"] == "explicit"

        invalid = client.put(
            "/api/v1/policies",
            json={
                "campaign_id": campaign_id,
                "area_pk": juliana["area_pk"],
                "product_guid": "2174",
                "low_target": 50,
                "high_target": 10,
            },
        )
        assert invalid.status_code == 422


def test_current_play_session_can_be_reassigned_without_losing_observations(
    session_factory, app_settings
) -> None:
    seed_complete_snapshots(session_factory)
    with session_factory() as session:
        play = session.scalar(select(PlaySession).where(PlaySession.is_current.is_(True)))
        assert play is not None
        target = Campaign(
            campaign_id="campaign-target",
            display_name="My established campaign",
            identity_key="seed:other|participant:41",
            game_seed="other",
            participant_guid="41",
            identity_method="user_assignment",
            identity_confidence="user_confirmed",
        )
        session.add(target)
        session.commit()
        play_id = play.play_session_id

    app = create_app(app_settings, session_factory)
    with TestClient(app) as client:
        response = client.patch(
            "/api/v1/campaigns",
            json={"campaign_id": "campaign-target", "play_session_id": play_id},
        )
        assert response.status_code == 200
        assert response.json()["play_session_id"] == play_id
        assert client.get("/api/v1/status").json()["play_session"]["campaign_id"] == "campaign-target"
        assert len(client.get("/api/v1/areas").json()["items"]) == 2
        assert len(client.get("/api/v1/inventory/latest").json()["items"]) == 2

    TelemetryIngestor(session_factory).ingest_line(
        source_path="fixture.log",
        source_fingerprint="fixture:1",
        source_offset=999_999,
        line=envelope(
            "snapshot_started",
            999,
            snapshot=99,
            data={
                "context": {
                    "participant_guid": "41",
                    "game_seed": "951",
                    "play_time": 2_000_000,
                },
                "area_enumeration_scope": "all_controlled_areas",
                "area_count": 0,
            },
        ),
    )
    with session_factory() as session:
        assert session.get(PlaySession, play_id).campaign_id == "campaign-target"


def test_recipe_signals_distinguish_input_pressure_from_output_blockage(
    session_factory, app_settings
) -> None:
    seed_complete_snapshots(session_factory)
    with session_factory() as session:
        latest = session.scalar(
            select(SnapshotBatch).order_by(SnapshotBatch.snapshot_sequence.desc())
        )
        assert latest is not None
        juliana = session.scalar(select(Area).where(Area.latest_name == "Juliana"))
        assert juliana is not None
        session.add_all(
            [
                BuildingType(
                    release_id="anno117-v1-starter",
                    building_guid="building-fixture",
                    name="Fixture workshop",
                ),
                ProductionRecipe(
                    release_id="anno117-v1-starter",
                    recipe_id="recipe-fixture",
                    building_guid="building-fixture",
                    name="Fixture chain",
                    cycle_seconds=30,
                ),
                ProductionRecipeItem(
                    release_id="anno117-v1-starter",
                    recipe_id="recipe-fixture",
                    role="input",
                    ordinal=1,
                    product_guid="2174",
                    amount=1,
                ),
                ProductionRecipeItem(
                    release_id="anno117-v1-starter",
                    recipe_id="recipe-fixture",
                    role="output",
                    ordinal=2,
                    product_guid="2176",
                    amount=1,
                ),
                AreaProductObservation(
                    snapshot_id=latest.snapshot_id,
                    area_pk=juliana.area_pk,
                    product_guid="2176",
                    stock=95,
                    available_stock=95,
                    storage_capacity=100,
                    reserved_amount=0,
                    free_space_raw=5,
                ),
            ]
        )
        session.commit()

    app = create_app(app_settings, session_factory)
    with TestClient(app) as client:
        chain = client.get("/api/v1/production/chains").json()["chains"][0]
        issues = {
            (signal["chain_issue"], signal["product_guid"], signal["area_name"])
            for signal in chain["inferred_pressures"]
        }
        assert ("input_pressure", "2174", "Naissus") in issues
        assert ("output_blockage", "2176", "Juliana") in issues
        assert "no measured factory rate" in chain["measurement_notice"].lower()


def test_api_contract_and_observed_types(session_factory, app_settings) -> None:
    seed_complete_snapshots(session_factory)
    app = create_app(app_settings, session_factory)
    with TestClient(app) as client:
        paths = client.get("/openapi.json").json()["paths"]
        expected = {
            "/api/v1/status",
            "/api/v1/campaigns",
            "/api/v1/dashboard/overview",
            "/api/v1/areas",
            "/api/v1/products",
            "/api/v1/inventory/latest",
            "/api/v1/inventory/history",
            "/api/v1/trade/opportunities",
            "/api/v1/production/chains",
            "/api/v1/finance",
            "/api/v1/workforce",
            "/api/v1/policies",
            "/api/v1/events",
        }
        assert expected <= paths.keys()
        status = client.get("/api/v1/status").json()
        assert status["database"]["journal_mode"] == "WAL"
        assert status["catalog"]["products"] == 3

        area = client.get("/api/v1/areas").json()["items"][0]
        economy_responses = [
            client.get("/api/v1/areas").json(),
            client.get("/api/v1/products").json(),
            client.get("/api/v1/inventory/latest").json(),
            client.get(
                "/api/v1/inventory/history",
                params={"area_pk": area["area_pk"], "product_guid": "2174"},
            ).json(),
            client.get("/api/v1/trade/opportunities").json(),
            client.get("/api/v1/production/chains").json(),
            client.get("/api/v1/finance").json(),
            client.get("/api/v1/workforce").json(),
            client.get("/api/v1/dashboard/overview").json(),
        ]
        for response in economy_responses:
            assert response["meta"]["snapshot_id"] is not None
            assert response["meta"]["play_session_id"] is not None
            assert response["meta"]["scope"] == "all_controlled_areas"
            assert response["catalog"]["release_id"] == "anno117-v1-starter"

    with session_factory() as session:
        assert session.scalar(select(func.count()).select_from(SnapshotBatch).where(SnapshotBatch.is_complete)) == 4
        population = session.scalars(select(AreaPopulationObservation)).first()
        assert population is not None and population.population_count == 100.5
        assert session.scalar(select(func.count()).select_from(ParticipantFinanceObservation)) == 4


def test_incomplete_newer_batch_does_not_replace_current_state(session_factory, app_settings) -> None:
    seed_complete_snapshots(session_factory)
    with session_factory() as session:
        current = session.scalar(select(SnapshotBatch).order_by(SnapshotBatch.snapshot_sequence.desc()))
        assert current is not None
        session.add(
            SnapshotBatch(
                play_session_id=current.play_session_id,
                snapshot_sequence=99,
                received_at=current.received_at,
                play_time=(current.play_time or 0) + 30_000,
                expected_area_count=2,
                emitted_area_count=1,
                area_enumeration_scope="all_controlled_areas",
                is_complete=False,
                normalization_status="partial",
            )
        )
        session.commit()
    app = create_app(app_settings, session_factory)
    with TestClient(app) as client:
        assert client.get("/api/v1/inventory/latest").json()["meta"]["snapshot_id"] == current.snapshot_id


@pytest.mark.parametrize(
    "play_times",
    [
        [1_000_000, 1_030_000, 1_030_000, 1_060_000],  # paused duplicate
        [1_000_000, 1_030_000, 1_120_000, 1_150_000],  # cadence gap > 2x
        [1_000_000, 1_030_000, 900_000, 930_000],  # game-clock rollback
    ],
)
def test_velocity_rejects_invalid_clock_intervals(
    session_factory, app_settings, play_times
) -> None:
    seed_complete_snapshots(session_factory)
    with session_factory() as session:
        snapshots = session.scalars(
            select(SnapshotBatch).order_by(SnapshotBatch.snapshot_sequence)
        ).all()
        for snapshot, play_time in zip(snapshots, play_times, strict=True):
            snapshot.play_time = play_time
        latest_source = session.scalar(
            select(AreaProductObservation)
            .where(AreaProductObservation.snapshot_id == snapshots[-1].snapshot_id)
            .order_by(AreaProductObservation.area_pk)
        )
        assert latest_source is not None
        latest_source.free_space_raw = -500
        session.commit()

    app = create_app(app_settings, session_factory)
    with TestClient(app) as client:
        inventory = client.get("/api/v1/inventory/latest").json()
        assert all(item["velocity"] is None for item in inventory["items"])
        source = next(item for item in inventory["items"] if item["area_name"] == "Juliana")
        assert source["free_space_raw"] == -500
        assert source["fill_ratio"] == 0.85
        assert not any(
            signal["code"] == "near_full" and signal["area_name"] == "Juliana"
            for signal in inventory["signals"]
        )
