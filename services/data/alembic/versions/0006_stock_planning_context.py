"""Persist need-consumption context for city stock planning.

Revision ID: 0006
Revises: 0005
"""

from alembic import op
import sqlalchemy as sa


revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    columns = {item["name"] for item in sa.inspect(op.get_bind()).get_columns("snapshot_batch")}
    if "need_consumption_setting" not in columns:
        op.add_column(
            "snapshot_batch",
            sa.Column("need_consumption_setting", sa.Integer(), nullable=True),
        )


def downgrade() -> None:
    columns = {item["name"] for item in sa.inspect(op.get_bind()).get_columns("snapshot_batch")}
    if "need_consumption_setting" in columns:
        op.drop_column("snapshot_batch", "need_consumption_setting")
