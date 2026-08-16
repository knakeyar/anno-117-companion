"""Add persistent current state, maps, workflows, and advisor storage.

Revision ID: 0002
Revises: 0001
"""

from alembic import op
import sqlalchemy as sa

from app.db import Base
from app import models  # noqa: F401

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def _add_column(table: str, column: sa.Column) -> None:
    inspector = sa.inspect(op.get_bind())
    if column.name not in {item["name"] for item in inspector.get_columns(table)}:
        op.add_column(table, column)


def upgrade() -> None:
    _add_column("static_release", sa.Column("source_url", sa.Text(), nullable=True))
    _add_column("static_release", sa.Column("source_revision", sa.String(), nullable=True))
    _add_column("static_release", sa.Column("attribution", sa.Text(), nullable=True))
    _add_column("product", sa.Column("associated_regions_json", sa.Text(), nullable=True))
    _add_column("product", sa.Column("dlc_unlocks_json", sa.Text(), nullable=True))
    _add_column("building_type", sa.Column("associated_regions_json", sa.Text(), nullable=True))
    _add_column("building_type", sa.Column("dlc_unlocks_json", sa.Text(), nullable=True))
    _add_column(
        "snapshot_batch",
        sa.Column("section_mode", sa.String(), nullable=False, server_default="full"),
    )
    _add_column("snapshot_batch", sa.Column("catalog_hash", sa.String(), nullable=True))

    Base.metadata.create_all(bind=op.get_bind())

    # Materialize the newest complete v1 observation for every campaign area
    # and product. This is intentionally additive: historical rows remain.
    op.execute(
        sa.text(
            """
            INSERT OR IGNORE INTO area_product_current (
                area_pk, product_guid, campaign_id, play_session_id, snapshot_id,
                stock, available_stock, storage_capacity, reserved_amount,
                free_space_raw, engine_trend_raw, passive_trade_minimum,
                offer_is_no_offer, offer_is_buy_only, offer_is_sell_only,
                offer_is_buy_or_sell, offer_is_preferred_good, observed_at,
                last_attempt_snapshot_id, section_status
            )
            SELECT o.area_pk, o.product_guid, a.campaign_id, s.play_session_id, s.snapshot_id,
                   o.stock, o.available_stock, o.storage_capacity, o.reserved_amount,
                   o.free_space_raw, o.engine_trend_raw, o.passive_trade_minimum,
                   o.offer_is_no_offer, o.offer_is_buy_only, o.offer_is_sell_only,
                   o.offer_is_buy_or_sell, o.offer_is_preferred_good,
                   COALESCE(s.completed_at, s.received_at), s.snapshot_id, 'success'
              FROM area_product_observation o
              JOIN snapshot_batch s ON s.snapshot_id = o.snapshot_id
              JOIN area a ON a.area_pk = o.area_pk
             WHERE s.is_complete = 1
               AND NOT EXISTS (
                    SELECT 1
                      FROM area_product_observation newer
                      JOIN snapshot_batch ns ON ns.snapshot_id = newer.snapshot_id
                     WHERE newer.area_pk = o.area_pk
                       AND newer.product_guid = o.product_guid
                       AND ns.is_complete = 1
                       AND (COALESCE(ns.completed_at, ns.received_at) > COALESCE(s.completed_at, s.received_at)
                            OR (COALESCE(ns.completed_at, ns.received_at) = COALESCE(s.completed_at, s.received_at)
                                AND ns.snapshot_id > s.snapshot_id))
               )
            """
        )
    )


def downgrade() -> None:
    # v1.1 data is deliberately retained; downgrading is not supported because
    # it would destroy locally managed route plans and advisor conversations.
    pass
