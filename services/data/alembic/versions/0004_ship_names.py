"""Persist player-visible names for assigned trade-route ships.

Revision ID: 0004
Revises: 0003
"""

from alembic import op
import sqlalchemy as sa


revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def _add_column(table: str, column: sa.Column) -> None:
    inspector = sa.inspect(op.get_bind())
    if column.name not in {item["name"] for item in inspector.get_columns(table)}:
        op.add_column(table, column)


def upgrade() -> None:
    _add_column("trade_route_ship_observation", sa.Column("ship_name", sa.String(), nullable=True))
    _add_column("active_trade_route_ship_current", sa.Column("ship_name", sa.String(), nullable=True))


def downgrade() -> None:
    # Names are additive local evidence. Retain them on downgrade.
    pass
