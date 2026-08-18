from __future__ import annotations

import math
from typing import Iterable


CARGO_SLOT_CAPACITY_TONS = 50.0


def ship_plan_analysis(
    amounts: Iterable[float],
    *,
    plan_kind: str,
    cargo_slots: int | None,
    expected_round_trip_minutes: float | None,
    ship_cost: float | None,
) -> dict:
    """Convert a typed plan into transparent slot and fleet assumptions.

    Recurring amounts are tons/minute and need a round-trip duration before a
    cycle load or fleet size can be calculated. One-time amounts are total tons;
    their ship count is the fleet required to move the total in one wave.
    Unlike goods each consume their own 50t slots, so their quantities are
    rounded to slots independently rather than summed first.
    """
    values = [float(amount) for amount in amounts]
    if cargo_slots is None or cargo_slots <= 0:
        return {
            "capacity_basis": "unknown",
            "target_amounts_per_cycle": None,
            "total_slots_required": None,
            "estimated_required_ships": None,
            "estimated_fleet_cost": None,
        }
    if plan_kind == "recurring_supply" and not expected_round_trip_minutes:
        return {
            "capacity_basis": "missing_round_trip_time",
            "target_amounts_per_cycle": None,
            "total_slots_required": None,
            "estimated_required_ships": None,
            "estimated_fleet_cost": None,
        }

    multiplier = expected_round_trip_minutes if plan_kind == "recurring_supply" else 1.0
    targets = [amount * multiplier for amount in values]
    slots_by_good = [math.ceil(target / CARGO_SLOT_CAPACITY_TONS) for target in targets]
    total_slots = sum(slots_by_good)
    required_ships = max(1, math.ceil(total_slots / cargo_slots)) if total_slots else 0
    return {
        "capacity_basis": (
            "recurring_round_trip_cycle" if plan_kind == "recurring_supply" else "one_time_single_wave"
        ),
        "target_amounts_per_cycle": [round(target, 3) for target in targets],
        "slots_by_good": slots_by_good,
        "total_slots_required": total_slots,
        "estimated_required_ships": required_ships,
        "estimated_fleet_cost": (
            round(required_ships * ship_cost, 2) if ship_cost is not None else None
        ),
    }
