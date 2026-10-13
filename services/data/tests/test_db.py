from __future__ import annotations

from pathlib import Path

from sqlalchemy.pool import NullPool

from app.db import create_sqlite_engine


def test_sqlite_engine_does_not_impose_a_bounded_connection_pool(tmp_path: Path) -> None:
    engine = create_sqlite_engine(tmp_path / "test.sqlite3")
    try:
        assert isinstance(engine.pool, NullPool)
    finally:
        engine.dispose()
