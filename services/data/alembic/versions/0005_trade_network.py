"""Add companion trade network identity and evidence.

Revision ID: 0005
Revises: 0004
"""

from __future__ import annotations

import base64
import hashlib

from alembic import op
import sqlalchemy as sa

from app import models  # noqa: F401
from app.db import Base

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def _add_column(table: str, column: sa.Column) -> None:
    inspector = sa.inspect(op.get_bind())
    if column.name not in {item["name"] for item in inspector.get_columns(table)}:
        op.add_column(table, column)


def _tag(plan_id: str, salt: int = 0) -> str:
    digest = hashlib.sha256(f"{plan_id}:{salt}".encode()).digest()
    token = base64.b32encode(digest).decode("ascii").rstrip("=")[:5]
    return f"AC-{token}"


def _abbr(value: str | None) -> str:
    cleaned = "".join(character for character in (value or "") if character.isalnum())
    return (cleaned[:3] or "CITY").upper()


def upgrade() -> None:
    _add_column("trade_plan", sa.Column("plan_kind", sa.String(), nullable=False, server_default="emergency_transfer"))
    _add_column("trade_plan", sa.Column("route_tag", sa.String(), nullable=True))
    _add_column("trade_plan", sa.Column("suggested_route_name", sa.String(), nullable=True))
    _add_column("trade_plan", sa.Column("usable_ship_capacity", sa.Float(), nullable=True))
    _add_column("trade_plan", sa.Column("expected_round_trip_minutes", sa.Float(), nullable=True))
    _add_column("trade_plan", sa.Column("runtime_status", sa.String(), nullable=False, server_default="not_detected"))
    _add_column("trade_plan", sa.Column("runtime_freshness", sa.String(), nullable=False, server_default="historical"))
    _add_column("trade_plan", sa.Column("goods_verification", sa.String(), nullable=False, server_default="planned_only"))
    _add_column("trade_plan", sa.Column("last_runtime_match_at", sa.DateTime(timezone=True), nullable=True))
    # Kept on the link because materialization removes ship rows from an old
    # route key after a rename. It is suggestion evidence, never auto-identity.
    # The table may not exist yet on an ordinary upgrade, so this column is
    # also present in the metadata used to create the new table below.
    connection = op.get_bind()
    for table_name in ("trade_route_link", "trade_route_good_observation"):
        Base.metadata.tables[table_name].create(bind=connection, checkfirst=True)
    _add_column("trade_route_link", sa.Column("ship_ids_json", sa.Text(), nullable=False, server_default="[]"))

    existing = connection.execute(sa.text(
        "SELECT campaign_id, route_tag FROM trade_plan WHERE route_tag IS NOT NULL"
    )).mappings().all()
    used: dict[str, set[str]] = {}
    for row in existing:
        used.setdefault(row["campaign_id"], set()).add(row["route_tag"])
    plans = connection.execute(sa.text("""
        SELECT p.trade_plan_id, p.campaign_id, source.latest_name AS source_name,
               destination.latest_name AS destination_name
          FROM trade_plan p
          JOIN area source ON source.area_pk = p.source_area_pk
          JOIN area destination ON destination.area_pk = p.destination_area_pk
         WHERE p.route_tag IS NULL
         ORDER BY p.created_at, p.trade_plan_id
    """)).mappings().all()
    for plan in plans:
        campaign_tags = used.setdefault(plan["campaign_id"], set())
        salt = 0
        tag = _tag(plan["trade_plan_id"], salt)
        while tag in campaign_tags:
            salt += 1
            tag = _tag(plan["trade_plan_id"], salt)
        campaign_tags.add(tag)
        route_name = f"{tag} {_abbr(plan['source_name'])}-{_abbr(plan['destination_name'])}"
        connection.execute(
            sa.text("UPDATE trade_plan SET route_tag=:tag, suggested_route_name=:name WHERE trade_plan_id=:plan_id"),
            {"tag": tag, "name": route_name, "plan_id": plan["trade_plan_id"]},
        )
    indexes = {item["name"] for item in sa.inspect(connection).get_indexes("trade_plan")}
    if "ux_trade_plan_campaign_tag" not in indexes:
        op.create_index(
            "ux_trade_plan_campaign_tag", "trade_plan", ["campaign_id", "route_tag"], unique=True
        )


def downgrade() -> None:
    # Companion workflow evidence is intentionally retained.
    pass
