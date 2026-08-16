"""Add ship-backed active trade route state.

Revision ID: 0003
Revises: 0002
"""

from alembic import op

from app import models  # noqa: F401
from app.db import Base

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    Base.metadata.create_all(bind=op.get_bind())


def downgrade() -> None:
    # Route observations are local historical evidence. Avoid silently deleting
    # them during a downgrade.
    pass
