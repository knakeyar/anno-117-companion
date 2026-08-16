from __future__ import annotations

from collections import defaultdict
import json
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import (
    Area,
    AreaBuildingCurrent,
    AreaPopulationObservation,
    AreaSnapshot,
    BuildingType,
    Product,
    ProductionRecipe,
    ProductionRecipeItem,
    SnapshotBatch,
)


REGION_NAMES = {"Roman": "Latium", "Celtic": "Albion"}
REGION_GUID_TO_ID = {"3225": "Roman", "3245": "Roman", "6626": "Celtic", "6627": "Celtic"}
WORKFORCE_ORDER = ["2181", "2184", "2185", "2186", "2192", "2196", "2197", "2198", "2199"]
SETTING_NAMES = {0: "Low", 1: "Medium", 2: "High"}


def _round(value: float | None) -> float | None:
    return round(value, 3) if value is not None else None


def _load_planning_catalog(path: Path, release_id: str | None) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    if release_id is not None and data.get("release_id") != release_id:
        return None
    return data


def _status(
    balance: float | None,
    demand: float | None,
    observed_net: float | None,
) -> str:
    threshold = max(0.05, abs(demand or 0) * 0.05)
    if observed_net is not None and observed_net < -threshold:
        return "deficit"
    if balance is None:
        return "unknown"
    if balance < -threshold:
        return "deficit"
    if balance <= threshold or (observed_net is not None and observed_net <= threshold):
        return "constrained" if balance != 0 or observed_net not in {None, 0} else "neutral"
    return "healthy"


def city_stock_planning(
    session: Session,
    inventory: dict[str, Any],
    *,
    area_pk: int,
    planning_catalog_path: Path,
) -> dict[str, Any] | None:
    """Build the city planning table from persisted observations and pinned catalog facts.

    Demand and supply are deliberately base-model estimates. Observed net stock
    change remains separate because inventory movement cannot be decomposed into
    production, population, construction, and trade with the validated runtime API.
    """
    area = session.get(Area, area_pk)
    if area is None:
        return None
    items = [item for item in inventory["items"] if item["area_pk"] == area_pk]
    release_id = inventory.get("catalog", {}).get("release_id")
    planning = _load_planning_catalog(planning_catalog_path, release_id)
    snapshot_id = inventory.get("meta", {}).get("snapshot_id")
    snapshot = session.get(SnapshotBatch, snapshot_id) if snapshot_id is not None else None

    population_rows = session.scalars(
        select(AreaPopulationObservation)
        .where(
            AreaPopulationObservation.snapshot_id == snapshot_id,
            AreaPopulationObservation.area_pk == area_pk,
        )
        .order_by(AreaPopulationObservation.ordinal)
    ).all() if snapshot_id is not None else []
    population_by_guid = {item.population_guid: item for item in population_rows}
    population_by_name = {
        (item.localized_name or "").strip().lower(): item for item in population_rows
    }
    area_snapshot = session.get(AreaSnapshot, (snapshot_id, area_pk)) if snapshot_id is not None else None

    products = {
        item.product_guid: item
        for item in session.scalars(
            select(Product).where(Product.release_id == release_id)
        ).all()
    } if release_id else {}
    buildings = {
        item.building_guid: item
        for item in session.scalars(
            select(BuildingType).where(BuildingType.release_id == release_id)
        ).all()
    } if release_id else {}
    recipes = session.scalars(
        select(ProductionRecipe).where(ProductionRecipe.release_id == release_id)
    ).all() if release_id else []
    recipe_items: dict[str, list[ProductionRecipeItem]] = defaultdict(list)
    for item in session.scalars(
        select(ProductionRecipeItem).where(ProductionRecipeItem.release_id == release_id)
    ).all() if release_id else []:
        recipe_items[item.recipe_id].append(item)
    building_state = {
        item.building_guid: item
        for item in session.scalars(
            select(AreaBuildingCurrent).where(
                AreaBuildingCurrent.area_pk == area_pk,
                AreaBuildingCurrent.campaign_id == area.campaign_id,
            )
        ).all()
    }

    flow: dict[str, dict[str, Any]] = defaultdict(
        lambda: {
            "input": 0.0,
            "output": 0.0,
            "input_unknown": False,
            "output_unknown": False,
            "input_sources": [],
            "output_sources": [],
        }
    )
    workforce_products: dict[tuple[str, str], set[str]] = defaultdict(set)
    for recipe in recipes:
        building = buildings.get(recipe.building_guid)
        state = building_state.get(recipe.building_guid)
        cycle = recipe.cycle_seconds
        regions = json.loads(building.associated_regions_json or "[]") if building else []
        workforce_guid = building.workforce_guid if building else None
        known = (
            state is not None
            and state.presence_status in {"installed", "not_installed"}
            and state.building_count is not None
            and cycle is not None
            and cycle > 0
        )
        for recipe_item in recipe_items.get(recipe.recipe_id, []):
            direction = recipe_item.role
            product_flow = flow[recipe_item.product_guid]
            for region in regions or ["Unknown"]:
                if workforce_guid:
                    workforce_products[(region, workforce_guid)].add(recipe_item.product_guid)
            if not known:
                product_flow[f"{direction}_unknown"] = True
                continue
            count = float(state.building_count or 0)
            rate = count * recipe_item.amount * 60.0 / float(cycle)
            product_flow[direction] += rate
            if count > 0:
                product_flow[f"{direction}_sources"].append(
                    {
                        "recipe_id": recipe.recipe_id,
                        "building_guid": recipe.building_guid,
                        "building_name": building.name if building else recipe.name,
                        "building_count": int(count),
                        "rate_per_minute": _round(rate),
                        "evidence": "catalog_cycle_and_observed_building_count",
                    }
                )

    factor_name = SETTING_NAMES.get(snapshot.need_consumption_setting) if snapshot else None
    factors = planning.get("consumption_factors", {}) if planning else {}
    consumption_factor = float(factors.get(factor_name, factors.get("Low", 1.0)))
    factor_source = "telemetry" if factor_name is not None else "catalog_low_assumption"
    group_rows: list[dict[str, Any]] = []
    planning_levels = planning.get("population_levels", []) if planning else []
    inventory_by_guid = {item["product_guid"]: item for item in items}
    area_region_id = REGION_GUID_TO_ID.get(area.confirmed_region_guid or "")

    for level in planning_levels:
        population_guid = str(level["population_guid"])
        workforce_guid = str(level["workforce_guid"])
        regions = list(level.get("associated_regions") or [])
        region_id = regions[0] if regions else "Unknown"
        population = population_by_guid.get(population_guid)
        if population is None:
            population = population_by_name.get(str(level["name"]).strip().lower())
        population_count = population.population_count if population else None
        residence_guid = str(level["residence_guid"])
        residence_state = building_state.get(residence_guid)
        if residence_state is not None and residence_state.building_count is not None:
            residence_count = float(residence_state.building_count)
            residence_count_source = "telemetry"
        elif population_count is not None and level.get("maximum_population_per_residence"):
            residence_count = float(population_count) / float(level["maximum_population_per_residence"])
            residence_count_source = "estimated_from_population"
        else:
            residence_count = None
            residence_count_source = "not_observed"

        need_by_product = {str(item["product_guid"]): item for item in level.get("needs", [])}
        relevant = set(need_by_product) | workforce_products.get((region_id, workforce_guid), set())
        rows = []
        natural_order = {guid: index for index, guid in enumerate(need_by_product)}
        for product_guid in relevant:
            observed = inventory_by_guid.get(product_guid)
            if observed is None:
                continue
            product_flow = flow[product_guid]
            need = need_by_product.get(product_guid)
            population_demand = (
                residence_count
                * float(need["base_consumption_per_residence_minute"])
                * consumption_factor
                if need is not None and residence_count is not None
                else 0.0 if need is None else None
            )
            production_demand = float(product_flow["input"])
            demand = (
                population_demand + production_demand
                if population_demand is not None and not product_flow["input_unknown"]
                else None
            )
            supply = float(product_flow["output"]) if not product_flow["output_unknown"] else None
            balance = supply - demand if supply is not None and demand is not None else None
            per_1000 = (
                population_demand / float(population_count) * 1000
                if population_demand is not None and population_count and population_count > 0
                else None
            )
            velocity = observed.get("velocity") or {}
            observed_net = velocity.get("net_stock_change_per_minute")
            rows.append(
                {
                    "product_guid": product_guid,
                    "resource_name": observed["product_name"],
                    "icon": products.get(product_guid).icon if product_guid in products else None,
                    "category": observed.get("category"),
                    "natural_order": natural_order.get(product_guid, 1000),
                    "stock": observed.get("stock"),
                    "capacity": observed.get("capacity"),
                    "fill_ratio": observed.get("fill_ratio"),
                    "population_demand_per_minute": _round(population_demand),
                    "production_input_demand_per_minute": _round(production_demand),
                    "demand_per_minute": _round(demand),
                    "per_1000": _round(per_1000),
                    "supply_per_minute": _round(supply),
                    "balance_per_minute": _round(balance),
                    "observed_net_stock_change_per_minute": _round(observed_net),
                    "velocity_confidence": velocity.get("confidence"),
                    "velocity_is_historical": bool(velocity.get("is_historical", False)),
                    "status": _status(balance, demand, observed_net),
                    "demand_sources": product_flow["input_sources"],
                    "supply_sources": product_flow["output_sources"],
                    "calculation_completeness": (
                        "modeled_base"
                        if demand is not None and supply is not None
                        else "partial"
                    ),
                }
            )
        if not rows:
            continue
        rows.sort(key=lambda item: (item["natural_order"], item["resource_name"]))
        counts = {key: 0 for key in ("deficit", "constrained", "healthy", "neutral", "unknown")}
        for row in rows:
            counts[row["status"]] += 1
        group_rows.append(
            {
                "key": f"{region_id}:{workforce_guid}",
                "label": f"{REGION_NAMES.get(region_id, region_id)} · {level['name']}",
                "region_id": region_id,
                "region_name": REGION_NAMES.get(region_id, region_id),
                "workforce_guid": workforce_guid,
                "population_guid": population_guid,
                "population_name": level["name"],
                "population": population_count,
                "residence_count": _round(residence_count),
                "residence_count_source": residence_count_source,
                "consumption_factor": consumption_factor,
                "consumption_setting": factor_name or "Low (assumed)",
                "consumption_setting_source": factor_source,
                "status_counts": counts,
                "items": rows,
            }
        )

    grouped_product_ids = {
        row["product_guid"]
        for group in group_rows
        for row in group["items"]
    }
    unclassified = [item for item in items if item["product_guid"] not in grouped_product_ids]
    if unclassified:
        rows = []
        for observed in sorted(unclassified, key=lambda item: item["product_name"]):
            velocity = observed.get("velocity") or {}
            observed_net = velocity.get("net_stock_change_per_minute")
            rows.append(
                {
                    "product_guid": observed["product_guid"],
                    "resource_name": observed["product_name"],
                    "icon": products.get(observed["product_guid"]).icon if observed["product_guid"] in products else None,
                    "category": observed.get("category"),
                    "natural_order": 1000,
                    "stock": observed.get("stock"),
                    "capacity": observed.get("capacity"),
                    "fill_ratio": observed.get("fill_ratio"),
                    "population_demand_per_minute": None,
                    "production_input_demand_per_minute": None,
                    "demand_per_minute": None,
                    "per_1000": None,
                    "supply_per_minute": None,
                    "balance_per_minute": None,
                    "observed_net_stock_change_per_minute": _round(observed_net),
                    "velocity_confidence": velocity.get("confidence"),
                    "velocity_is_historical": bool(velocity.get("is_historical", False)),
                    "status": _status(None, None, observed_net),
                    "demand_sources": [],
                    "supply_sources": [],
                    "calculation_completeness": "unknown_catalog_relationships",
                }
            )
        group_rows.append(
            {
                "key": "Other:unknown",
                "label": "Other resources · not classified",
                "region_id": "Other",
                "region_name": "Other resources",
                "workforce_guid": None,
                "population_guid": None,
                "population_name": None,
                "population": area_snapshot.population_total if area_snapshot else None,
                "residence_count": area_snapshot.residence_count if area_snapshot else None,
                "residence_count_source": "area_total",
                "consumption_factor": consumption_factor,
                "consumption_setting": factor_name or "Low (assumed)",
                "consumption_setting_source": factor_source,
                "status_counts": {
                    key: sum(row["status"] == key for row in rows)
                    for key in ("deficit", "constrained", "healthy", "neutral", "unknown")
                },
                "items": rows,
            }
        )

    def group_rank(group: dict[str, Any]) -> tuple[int, int, str]:
        region_rank = 0 if group["region_id"] == area_region_id else 1 if group["region_id"] in REGION_NAMES else 2
        workforce_guid = group.get("workforce_guid")
        workforce_rank = WORKFORCE_ORDER.index(workforce_guid) if workforce_guid in WORKFORCE_ORDER else len(WORKFORCE_ORDER)
        return region_rank, workforce_rank, group["label"]

    group_rows.sort(key=group_rank)
    return {
        "meta": inventory["meta"],
        "catalog": inventory["catalog"],
        "area": {
            "area_pk": area.area_pk,
            "area_name": area.latest_name or area.area_id_raw,
            "region_guid": area.confirmed_region_guid,
            "population_total": area_snapshot.population_total if area_snapshot else None,
            "residence_count": area_snapshot.residence_count if area_snapshot else None,
        },
        "groups": group_rows,
        "capabilities": {
            "stock": True,
            "observed_net_stock_change": True,
            "population_demand": planning is not None,
            "factory_base_capacity": bool(recipes),
            "construction_demand": False,
            "active_project_demand": False,
            "trade_flow_decomposition": False,
            "runtime_modifiers": False,
        },
        "measurement_notice": (
            "Demand and supply are base planning estimates from pinned need rates, recipe cycles, "
            "and observed residence/factory counts. Buffs, disabled needs, construction, projects, "
            "and trade movements are excluded. Observed net stock change is shown separately."
        ),
        "planning_source": {
            "source_url": planning.get("source_url") if planning else None,
            "source_revision": planning.get("source_revision") if planning else None,
            "residence_counts": "telemetry where available; otherwise estimated from population at full catalog occupancy",
        },
    }
