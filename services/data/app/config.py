from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _repo_catalog() -> Path:
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "catalog" / "anno117-community-2.1-c6a6e752.json"
        if candidate.is_file():
            return candidate
    return Path("/app/catalog/anno117-community-2.1-c6a6e752.json")


@dataclass(frozen=True, slots=True)
class Settings:
    database_path: Path
    telemetry_dir: Path
    telemetry_glob: str
    catalog_path: Path
    poll_interval_seconds: float
    expected_snapshot_interval_seconds: int
    stale_after_seconds: int
    enable_tailer: bool
    openai_api_key: str | None = None
    openai_model: str = "gpt-5.6-luna"
    openai_reasoning_effort: str = "low"
    openai_timeout_seconds: float = 30.0

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            database_path=Path(os.getenv("ANNO_DATABASE_PATH", "/data/anno-companion.sqlite3")),
            telemetry_dir=Path(os.getenv("ANNO_TELEMETRY_DIR", "/telemetry")),
            telemetry_glob=os.getenv("ANNO_TELEMETRY_GLOB", "*.log"),
            catalog_path=Path(os.getenv("ANNO_CATALOG_PATH", str(_repo_catalog()))),
            poll_interval_seconds=float(os.getenv("ANNO_POLL_INTERVAL_SECONDS", "1")),
            expected_snapshot_interval_seconds=int(os.getenv("ANNO_SNAPSHOT_INTERVAL_SECONDS", "30")),
            stale_after_seconds=int(os.getenv("ANNO_STALE_AFTER_SECONDS", "75")),
            enable_tailer=os.getenv("ANNO_ENABLE_TAILER", "true").lower() not in {"0", "false", "no"},
            openai_api_key=os.getenv("OPENAI_API_KEY") or None,
            openai_model=os.getenv("OPENAI_MODEL", "gpt-5.6-luna"),
            openai_reasoning_effort=os.getenv("OPENAI_REASONING_EFFORT", "low"),
            openai_timeout_seconds=float(os.getenv("OPENAI_TIMEOUT_SECONDS", "30")),
        )


settings = Settings.from_env()
