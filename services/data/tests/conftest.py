from __future__ import annotations

import os
from pathlib import Path

import pytest
from sqlalchemy.orm import Session, sessionmaker

os.environ.setdefault("ANNO_DATABASE_PATH", "/tmp/anno-companion-pytest-default.sqlite3")
os.environ.setdefault("ANNO_ENABLE_TAILER", "false")

from app.config import Settings  # noqa: E402
from app.db import Base, create_sqlite_engine  # noqa: E402
from app.models import StaticRelease  # noqa: E402
from app.catalog import load_catalog  # noqa: E402


@pytest.fixture
def catalog_path() -> Path:
    return Path(__file__).resolve().parents[3] / "catalog" / "starter-catalog.json"


@pytest.fixture
def session_factory(tmp_path: Path, catalog_path: Path) -> sessionmaker[Session]:
    engine = create_sqlite_engine(tmp_path / "test.sqlite3")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, class_=Session, expire_on_commit=False, autoflush=False)
    with factory() as session:
        load_catalog(session, catalog_path)
    yield factory
    engine.dispose()


@pytest.fixture
def app_settings(tmp_path: Path, catalog_path: Path) -> Settings:
    telemetry = tmp_path / "telemetry"
    telemetry.mkdir()
    return Settings(
        database_path=tmp_path / "test.sqlite3",
        telemetry_dir=telemetry,
        telemetry_glob="*.log",
        catalog_path=catalog_path,
        poll_interval_seconds=0.01,
        expected_snapshot_interval_seconds=30,
        stale_after_seconds=75,
        enable_tailer=False,
    )
