from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Awaitable, Callable

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from .models import IngestionCursor, TelemetryRaw
from .normalizer import NormalizationResult, normalize_raw

logger = logging.getLogger(__name__)

PRODUCTION_PREFIX = "ANNO_COMPANION_TELEMETRY_JSON "
LEGACY_PREFIX = "ANNO_COMPANION_PROBE_JSON "


@dataclass(slots=True)
class ParsedLine:
    source_kind: str
    payload: str
    envelope: dict | None
    error: str | None


def parse_log_line(line: str) -> ParsedLine | None:
    matches = [
        (line.find(PRODUCTION_PREFIX), PRODUCTION_PREFIX, "production"),
        (line.find(LEGACY_PREFIX), LEGACY_PREFIX, "legacy_probe"),
    ]
    matches = [item for item in matches if item[0] >= 0]
    if not matches:
        return None
    position, prefix, kind = min(matches, key=lambda item: item[0])
    payload = line[position + len(prefix) :].strip()
    try:
        envelope = json.loads(payload)
        if not isinstance(envelope, dict):
            raise ValueError("telemetry payload is not a JSON object")
        return ParsedLine(kind, payload, envelope, None)
    except (json.JSONDecodeError, ValueError) as exc:
        return ParsedLine(kind, payload, None, str(exc))


def _fingerprint(path: Path) -> str:
    stat = path.stat()
    return f"{stat.st_dev}:{stat.st_ino}"


class TelemetryIngestor:
    def __init__(self, session_factory: sessionmaker[Session]):
        self.session_factory = session_factory

    def ingest_line(
        self,
        *,
        source_path: str,
        source_fingerprint: str,
        source_offset: int,
        line: str,
        received_at: datetime | None = None,
    ) -> NormalizationResult:
        parsed = parse_log_line(line)
        if parsed is None:
            return NormalizationResult()
        envelope = parsed.envelope or {}
        payload_hash = hashlib.sha256(parsed.payload.encode("utf-8", errors="replace")).hexdigest()
        with self.session_factory() as session:
            raw = TelemetryRaw(
                source_path=source_path,
                source_fingerprint=source_fingerprint,
                source_offset=source_offset,
                source_kind=parsed.source_kind,
                received_at=received_at or datetime.now(UTC),
                sequence_no=_optional_int(envelope.get("sequence")),
                load_epoch=_optional_int(envelope.get("load_epoch")),
                snapshot_sequence=_optional_int(
                    envelope.get("snapshot_sequence") or envelope.get("sample_number")
                ),
                event_type=str(envelope.get("event_type", "parse_error")),
                schema_version=_optional_int(envelope.get("schema_version")),
                mod_version=_optional_text(envelope.get("mod_version") or envelope.get("probe_version")),
                payload_json=parsed.payload,
                payload_sha256=payload_hash,
                parse_status="parse_error" if parsed.error else "parsed",
                parse_error=parsed.error,
            )
            session.add(raw)
            try:
                session.flush()
            except IntegrityError:
                session.rollback()
                return NormalizationResult()

            result = NormalizationResult()
            if parsed.envelope is not None:
                try:
                    result = normalize_raw(session, raw, parsed.envelope)
                except Exception as exc:  # preserve raw evidence even if normalization fails
                    logger.exception("normalization failed for %s:%s", source_path, source_offset)
                    raw.parse_status = "normalization_error"
                    raw.parse_error = str(exc)
            session.commit()
            return result


def _optional_int(value) -> int | None:  # type: ignore[no-untyped-def]
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _optional_text(value) -> str | None:  # type: ignore[no-untyped-def]
    return str(value) if value is not None else None


class TelemetryTailer:
    def __init__(
        self,
        *,
        telemetry_dir: Path,
        glob_pattern: str,
        poll_interval: float,
        session_factory: sessionmaker[Session],
        on_snapshot: Callable[[int], Awaitable[None]] | None = None,
    ):
        self.telemetry_dir = telemetry_dir
        self.glob_pattern = glob_pattern
        self.poll_interval = poll_interval
        self.session_factory = session_factory
        self.ingestor = TelemetryIngestor(session_factory)
        self.on_snapshot = on_snapshot
        self._stopping = asyncio.Event()

    async def run(self) -> None:
        logger.info("tailing %s/%s", self.telemetry_dir, self.glob_pattern)
        while not self._stopping.is_set():
            try:
                await self.poll_once()
            except Exception:
                logger.exception("telemetry polling failed")
            try:
                await asyncio.wait_for(self._stopping.wait(), timeout=self.poll_interval)
            except TimeoutError:
                pass

    def stop(self) -> None:
        self._stopping.set()

    async def poll_once(self) -> int:
        if not self.telemetry_dir.exists():
            return 0
        processed = 0
        matching_paths = sorted(
            (path for path in self.telemetry_dir.glob(self.glob_pattern) if path.is_file()),
            key=lambda path: (path.stat().st_mtime_ns, str(path)),
        )
        if not matching_paths:
            return 0
        with self.session_factory() as session:
            known_fingerprints = {
                cursor.source_fingerprint.split(":reset:", 1)[0]
                for cursor in session.scalars(select(IngestionCursor)).all()
            }
        # On first start, follow only the newest matching game log instead of
        # replaying every archived log in the Documents directory. If an active
        # file is renamed during rotation, its inode fingerprint keeps it in the
        # candidate set long enough to consume any unread tail.
        candidates = {
            path
            for path in matching_paths
            if _fingerprint(path) in known_fingerprints
        }
        candidates.add(matching_paths[-1])
        paths = sorted(candidates, key=lambda path: (path.stat().st_mtime_ns, str(path)))
        for path in paths:
            completed_ids = self._process_file(path)
            processed += len(completed_ids)
            if self.on_snapshot is not None:
                for snapshot_id in completed_ids:
                    await self.on_snapshot(snapshot_id)
        return processed

    def _process_file(self, path: Path) -> list[int]:
        base_fingerprint = _fingerprint(path)
        stat = path.stat()
        source_path = str(path.resolve())
        with self.session_factory() as session:
            cursor = session.get(IngestionCursor, source_path)
            if cursor is None:
                cursor = session.scalar(
                    select(IngestionCursor).where(
                        IngestionCursor.source_fingerprint.like(f"{base_fingerprint}%")
                    )
                )
                if cursor is not None:
                    cursor.source_path = source_path
                    cursor.file_size = stat.st_size
                else:
                    cursor = IngestionCursor(
                        source_path=source_path,
                        source_fingerprint=base_fingerprint,
                        byte_offset=0,
                        file_size=stat.st_size,
                    )
                    session.add(cursor)
                session.commit()
            elif not cursor.source_fingerprint.startswith(base_fingerprint):
                cursor.source_fingerprint = base_fingerprint
                cursor.byte_offset = 0
                cursor.last_error = None
                session.commit()
            elif stat.st_size < cursor.byte_offset:
                cursor.source_fingerprint = (
                    f"{base_fingerprint}:reset:{stat.st_mtime_ns}:{stat.st_size}"
                )
                cursor.byte_offset = 0
                cursor.last_error = None
                session.commit()
            fingerprint = cursor.source_fingerprint
            offset = cursor.byte_offset

        completed: list[int] = []
        with path.open("rb") as stream:
            stream.seek(offset)
            while True:
                line_start = stream.tell()
                raw_line = stream.readline()
                if not raw_line:
                    break
                if not raw_line.endswith((b"\n", b"\r")):
                    stream.seek(line_start)
                    break
                line = raw_line.decode("utf-8", errors="replace")
                result = self.ingestor.ingest_line(
                    source_path=source_path,
                    source_fingerprint=fingerprint,
                    source_offset=line_start,
                    line=line,
                )
                if result.completed_snapshot_id is not None:
                    completed.append(result.completed_snapshot_id)
            new_offset = stream.tell()

        with self.session_factory() as session:
            cursor = session.get(IngestionCursor, source_path)
            if cursor is not None:
                cursor.byte_offset = new_offset
                cursor.file_size = path.stat().st_size
                cursor.last_read_at = datetime.now(UTC)
                cursor.last_error = None
                session.commit()
        return completed
