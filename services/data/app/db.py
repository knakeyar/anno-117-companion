from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

from sqlalchemy import Engine, create_engine, event
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker
from sqlalchemy.pool import NullPool

from .config import settings


class Base(DeclarativeBase):
    pass


def create_sqlite_engine(database_path: Path | str) -> Engine:
    path = Path(database_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(
        f"sqlite:///{path}",
        connect_args={"check_same_thread": False, "timeout": 30},
        # A request may outlive its browser fetch when an analytics query is
        # slow.  A bounded QueuePool then turns those still-running SQLite
        # readers into a service-wide 30 second pool timeout.  SQLite is a
        # local file database, so short-lived connections are cheap and avoid
        # an arbitrary connection ceiling while WAL handles concurrent reads.
        poolclass=NullPool,
        future=True,
    )

    @event.listens_for(engine, "connect")
    def configure_sqlite(dbapi_connection, _connection_record) -> None:  # type: ignore[no-untyped-def]
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA busy_timeout=30000")
        cursor.close()

    return engine


engine = create_sqlite_engine(settings.database_path)
SessionLocal = sessionmaker(bind=engine, class_=Session, expire_on_commit=False, autoflush=False)


def get_session() -> Iterator[Session]:
    with SessionLocal() as session:
        yield session

