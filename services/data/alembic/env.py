from __future__ import annotations

from logging.config import fileConfig

from alembic import context

from app.config import settings
from app.db import Base
from app import models  # noqa: F401

config = context.config
config.set_main_option("sqlalchemy.url", f"sqlite:///{settings.database_path}")

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        render_as_batch=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    from app.db import create_sqlite_engine

    connectable = create_sqlite_engine(settings.database_path)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, render_as_batch=True)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

