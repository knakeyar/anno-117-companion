from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from sqlalchemy import func, select

from app.ingestion import LEGACY_PREFIX, PRODUCTION_PREFIX, TelemetryIngestor, TelemetryTailer, parse_log_line
from app.models import (
    Area,
    AreaWorkforceObservation,
    PlaySession,
    SnapshotBatch,
    SnapshotSectionStatus,
    TelemetryRaw,
)

from .helpers import envelope


def test_parser_tolerates_noise_and_reports_malformed_json() -> None:
    assert parse_log_line("ordinary game line") is None
    parsed = parse_log_line(f"prefix {PRODUCTION_PREFIX}{{bad json}}\n")
    assert parsed is not None
    assert parsed.source_kind == "production"
    assert parsed.envelope is None
    assert parsed.error


def test_duplicate_source_offset_is_idempotent(session_factory) -> None:
    ingestor = TelemetryIngestor(session_factory)
    line = envelope("telemetry_loaded", 1)
    for _ in range(2):
        ingestor.ingest_line(
            source_path="game.log",
            source_fingerprint="one",
            source_offset=42,
            line=line,
        )
    with session_factory() as session:
        assert session.scalar(select(func.count()).select_from(TelemetryRaw)) == 1


def test_duplicate_payload_at_new_offset_does_not_duplicate_play_epoch(session_factory) -> None:
    ingestor = TelemetryIngestor(session_factory)
    line = envelope("telemetry_loaded", 1)
    for offset in [0, len(line.encode())]:
        ingestor.ingest_line(
            source_path="game.log",
            source_fingerprint="one",
            source_offset=offset,
            line=line,
        )
    with session_factory() as session:
        assert session.scalar(select(func.count()).select_from(TelemetryRaw)) == 2
        assert session.scalar(select(func.count()).select_from(PlaySession)) == 1


def test_tailer_waits_for_complete_lines_and_recovers_from_truncation(
    session_factory, tmp_path: Path
) -> None:
    log = tmp_path / "game.log"
    log.write_text(envelope("telemetry_loaded", 1))
    tailer = TelemetryTailer(
        telemetry_dir=tmp_path,
        glob_pattern="*.log",
        poll_interval=0.01,
        session_factory=session_factory,
    )
    asyncio.run(tailer.poll_once())
    with log.open("a") as stream:
        stream.write(envelope("telemetry_initialized", 2).rstrip("\n"))
    asyncio.run(tailer.poll_once())
    with session_factory() as session:
        assert session.scalar(select(func.count()).select_from(TelemetryRaw)) == 1
    with log.open("a") as stream:
        stream.write("\n")
    asyncio.run(tailer.poll_once())
    with session_factory() as session:
        assert session.scalar(select(func.count()).select_from(TelemetryRaw)) == 2

    log.write_text(envelope("telemetry_loaded", 1))
    asyncio.run(tailer.poll_once())
    with session_factory() as session:
        assert session.scalar(select(func.count()).select_from(TelemetryRaw)) == 3


def test_tailer_ignores_archives_then_finishes_renamed_active_log(
    session_factory, tmp_path: Path
) -> None:
    archived = tmp_path / "old.log"
    active = tmp_path / "game.log"
    archived.write_text(envelope("telemetry_loaded", 1))
    active.write_text(envelope("telemetry_loaded", 1))
    os.utime(archived, (1, 1))
    os.utime(active, (2, 2))
    tailer = TelemetryTailer(
        telemetry_dir=tmp_path,
        glob_pattern="*.log",
        poll_interval=0.01,
        session_factory=session_factory,
    )
    asyncio.run(tailer.poll_once())
    with session_factory() as session:
        assert session.scalar(select(func.count()).select_from(TelemetryRaw)) == 1

    with active.open("a") as stream:
        stream.write(envelope("telemetry_initialized", 2))
    rotated = tmp_path / "game-rotated.log"
    active.rename(rotated)
    active.write_text(envelope("telemetry_loaded", 1).replace('"load_epoch": 1', '"load_epoch": 2'))
    asyncio.run(tailer.poll_once())
    with session_factory() as session:
        assert session.scalar(select(func.count()).select_from(TelemetryRaw)) == 3
        assert session.scalar(select(func.count()).select_from(PlaySession)) == 2


def test_legacy_probe_normalizes_area_identity_but_not_ui_statistics(session_factory) -> None:
    ingestor = TelemetryIngestor(session_factory)
    offset = 0

    def ingest(payload: dict) -> None:
        nonlocal offset
        line = f"[SCRIPT] {LEGACY_PREFIX}{json.dumps(payload)}\n"
        ingestor.ingest_line(
            source_path="scope.log",
            source_fingerprint="scope:1",
            source_offset=offset,
            line=line,
        )
        offset += len(line.encode())

    base = {"schema_version": 0, "probe_version": "0.2.1", "load_epoch": 1, "ok": True}
    ingest({**base, "sequence": 1, "sample_number": 0, "event_type": "scope_probe_loaded", "data": {}})
    areas = [
        {"ID": 8000 + index, "id_string": str(8000 + index), "CityName": f"Area {index}", "is_valid": True}
        for index in range(12)
    ]
    ingest(
        {
            **base,
            "sequence": 2,
            "sample_number": 1,
            "event_type": "scope_context",
            "data": {
                "participant": {"GetCurrentParticipantGUID": 41},
                "game_setup": {"GameSeed": 951},
                "session": {"SessionGUID": 3245, "RegionGUID": 3225},
                "current_area": areas[0],
                "controlled_areas": {
                    "reported_count": 12,
                    "captured_count": 12,
                    "truncated": False,
                    "areas": areas,
                },
                "clocks": {"play_time": {"value": 1000}, "corporation_time": {"value": 2000}},
            },
        }
    )
    ingest(
        {
            **base,
            "sequence": 3,
            "sample_number": 1,
            "event_type": "scope_statistics",
            "data": {"num_selected_areas": 12, "products": [{"product_guid": 2174, "generation_per_minute": 42}]},
        }
    )
    ingest(
        {
            **base,
            "sequence": 4,
            "sample_number": 1,
            "event_type": "scope_workforce",
            "ok": False,
            "data": {"section_errors": {"Workforces": "weak reference was null"}, "workforces": []},
        }
    )
    with session_factory() as session:
        assert session.scalar(select(func.count()).select_from(Area)) == 12
        snapshot = session.scalars(select(SnapshotBatch)).one()
        assert snapshot.is_complete is False
        assert session.scalar(select(func.count()).select_from(AreaWorkforceObservation)) == 0
        status = session.scalar(
            select(SnapshotSectionStatus).where(
                SnapshotSectionStatus.section_name == "legacy_ui_statistics_raw_only"
            )
        )
        assert status is not None and status.status == "not_normalized"


def test_supplied_probe_fixtures_preserve_validated_scope(session_factory) -> None:
    ingestor = TelemetryIngestor(session_factory)
    fixtures = Path(__file__).parent / "fixtures"
    for fixture in ["legacy-probe-0.2.0.log", "legacy-probe-0.2.1.log"]:
        path = fixtures / fixture
        offset = 0
        for line in path.read_text(encoding="utf-8").splitlines(keepends=True):
            ingestor.ingest_line(
                source_path=fixture,
                source_fingerprint=fixture,
                source_offset=offset,
                line=line,
            )
            offset += len(line.encode("utf-8"))

    with session_factory() as session:
        assert session.scalar(select(func.count()).select_from(TelemetryRaw)) == 30
        assert session.scalar(
            select(func.count()).select_from(TelemetryRaw).where(TelemetryRaw.parse_status != "normalized")
        ) == 0

        # The runtime evidence contains twelve campaign-scoped areas. Region/session
        # context is evidence for the current camera area, never part of area identity.
        assert session.scalar(select(func.count()).select_from(Area)) == 12

        raw_only = session.scalars(
            select(SnapshotSectionStatus).where(
                SnapshotSectionStatus.section_name == "legacy_ui_statistics_raw_only"
            )
        ).all()
        assert len(raw_only) == 3
        assert all(item.status == "not_normalized" for item in raw_only)

        sample_24 = session.scalar(
            select(SnapshotBatch)
            .join(PlaySession)
            .where(PlaySession.mod_version == "0.2.1", SnapshotBatch.snapshot_sequence == 24)
        )
        assert sample_24 is not None
        assert sample_24.is_complete is False
        assert sample_24.normalization_status == "legacy_partial"
        workforce = session.scalar(
            select(SnapshotSectionStatus).where(
                SnapshotSectionStatus.snapshot_id == sample_24.snapshot_id,
                SnapshotSectionStatus.section_name == "legacy_workforce",
            )
        )
        assert workforce is not None and workforce.status == "not_observed"
        assert session.scalar(
            select(func.count())
            .select_from(AreaWorkforceObservation)
            .where(AreaWorkforceObservation.snapshot_id == sample_24.snapshot_id)
        ) == 0
