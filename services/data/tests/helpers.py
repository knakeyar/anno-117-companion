from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session, sessionmaker

from app.ingestion import PRODUCTION_PREFIX, TelemetryIngestor


def envelope(event_type: str, sequence: int, *, snapshot: int | None = None, data=None, ok=True) -> str:
    payload = {
        "schema_version": 1,
        "mod_version": "1.0.0",
        "catalog_release": "anno117-v1-starter",
        "catalog_hash": "fixture",
        "event_type": event_type,
        "sequence": sequence,
        "load_epoch": 1,
        "snapshot_sequence": snapshot,
        "ok": ok,
        "data": data or {},
    }
    return f"[SCRIPT][INFO] {PRODUCTION_PREFIX}{json.dumps(payload)}\n"


def area_payload(area_id: str, name: str, timber_stock: float, *, current: bool = False) -> dict:
    return {
        "ID": int(area_id),
        "area_id": area_id,
        "CityName": name,
        "Owner": 41,
        "OwnerName": "Marcia",
        "IsOwnedByCurrentParticipant": True,
        "HasAreaEconomy": True,
        "is_current_area": current,
        "products": [
            {
                "product_guid": "2174",
                "stock": timber_stock,
                "available": timber_stock,
                "capacity": 100,
                "reserved": 0,
                "free_space_raw": 100 - timber_stock,
                "engine_trend_raw": -1,
                "passive_trade": {
                    "minimum_stock": 0,
                    "offer": {
                        "IsNoOffer": True,
                        "IsBuyOnly": False,
                        "IsSellOnly": False,
                        "IsBuyOrSell": False,
                        "IsPreferedGood": False,
                    },
                },
            }
        ],
        "population": {
            "summary": {"PopulationCount": 100.5, "AmountOfResidences": 20},
            "area_money": {"TotalMoneyIncome": 125, "LandTax": 12},
            "levels": [
                {
                    "Guid": 27081,
                    "Text": "Liberti",
                    "ordinal": 1,
                    "population_count": 100.5,
                    "satisfaction": 80,
                }
            ],
        },
        "workforce": {
            "items": [
                {
                    "Guid": 2181,
                    "Text": "Libertus Workforce",
                    "ordinal": 1,
                    "population_count": 100.5,
                    "resulting_from_population": 50.25,
                    "registered_production": 55.25,
                    "registered_consumption": -60,
                    "delta_without_buffs": -4.75,
                    "delta_with_buffs": -4.75,
                }
            ]
        } if current else None,
    }


def seed_complete_snapshots(factory: sessionmaker[Session]) -> None:
    ingestor = TelemetryIngestor(factory)
    offset = 0
    sequence = 1
    received = datetime.now(UTC) - timedelta(minutes=2)

    def ingest(line: str, at: datetime) -> None:
        nonlocal offset
        ingestor.ingest_line(
            source_path="fixture.log",
            source_fingerprint="fixture:1",
            source_offset=offset,
            line=line,
            received_at=at,
        )
        offset += len(line.encode())

    ingest(envelope("telemetry_loaded", sequence), received)
    sequence += 1
    for snapshot, (source_stock, destination_stock) in enumerate(
        [(100, 20), (95, 15), (90, 10), (85, 5)], start=1
    ):
        at = received + timedelta(seconds=snapshot * 30)
        ingest(
            envelope(
                "snapshot_started",
                sequence,
                snapshot=snapshot,
                data={
                    "context": {
                        "participant_guid": "41",
                        "game_seed": "951",
                        "game_session_guid": "3245",
                        "region_guid": "3225",
                        "current_area_id": "8513",
                        "play_time": 1_000_000 + snapshot * 30_000,
                        "corporation_time": 2_000_000 + snapshot * 30_000,
                    },
                    "area_enumeration_scope": "all_controlled_areas",
                    "area_count": 2,
                    "captured_area_count": 2,
                    "areas_truncated": False,
                },
            ),
            at,
        )
        sequence += 1
        ingest(
            envelope(
                "participant_snapshot",
                sequence,
                snapshot=snapshot,
                data={
                    "finance": {
                        "participant_guid": "41",
                        "treasury": 3_756_154,
                        "money": {
                            "TotalIncome": 200,
                            "TradeBalance": 50,
                            "PassiveTradeBalance": 20,
                            "ActiveTradeBalance": 30,
                        },
                        "categories": [
                            {"kind": "positive", "ordinal": 1, "Guid": 0, "Text": "Taxes", "ValueAsFloat": 300},
                            {"kind": "negative", "ordinal": 1, "Guid": 0, "Text": "Maintenance", "ValueAsFloat": -100},
                        ],
                    },
                    "route_issues": {
                        "items": [
                            {
                                "ordinal": 1,
                                "Name": "Supply route",
                                "NoShipsActive": True,
                                "ActiveErrorCount": 1,
                            }
                        ]
                    },
                },
            ),
            at,
        )
        sequence += 1
        for area in [
            area_payload("8513", "Juliana", source_stock, current=True),
            area_payload("8961", "Naissus", destination_stock),
        ]:
            ingest(envelope("area_snapshot", sequence, snapshot=snapshot, data=area), at)
            sequence += 1
        ingest(
            envelope(
                "snapshot_completed",
                sequence,
                snapshot=snapshot,
                data={
                    "expected_area_count": 2,
                    "emitted_area_count": 2,
                    "failed_area_count": 0,
                    "complete": True,
                },
            ),
            at,
        )
        sequence += 1
