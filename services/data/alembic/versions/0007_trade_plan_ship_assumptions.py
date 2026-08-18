"""Add per-user ship assumptions to trade plans.

Revision ID: 0007
Revises: 0006
"""

from alembic import op
import sqlalchemy as sa


revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def _add_column(table: str, column: sa.Column) -> None:
    columns = {item["name"] for item in sa.inspect(op.get_bind()).get_columns(table)}
    if column.name not in columns:
        op.add_column(table, column)


def upgrade() -> None:
    _add_column("trade_plan", sa.Column("cargo_slots", sa.Integer(), nullable=True))
    _add_column("trade_plan", sa.Column("ship_cost", sa.Float(), nullable=True))
    op.execute(sa.text(
        "UPDATE trade_plan "
        "SET cargo_slots = CAST(usable_ship_capacity / 50 AS INTEGER) "
        "WHERE cargo_slots IS NULL AND usable_ship_capacity >= 50 "
        "AND usable_ship_capacity <= 1000 "
        "AND CAST(usable_ship_capacity AS INTEGER) % 50 = 0"
    ))


def downgrade() -> None:
    columns = {item["name"] for item in sa.inspect(op.get_bind()).get_columns("trade_plan")}
    if "ship_cost" in columns:
        op.drop_column("trade_plan", "ship_cost")
    if "cargo_slots" in columns:
        op.drop_column("trade_plan", "cargo_slots")
