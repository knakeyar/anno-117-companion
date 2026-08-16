from __future__ import annotations

from collections import defaultdict
import math
from typing import Any


REGION_GUID_TO_ID = {"3225": "Roman", "3245": "Roman", "6626": "Celtic", "6627": "Celtic"}
STATUS_ORDER = {
    "missing": 0,
    "deficit": 1,
    "constrained": 2,
    "risk": 3,
    "import_required": 4,
    "unknown": 5,
    "healthy": 6,
    "neutral": 7,
    "raw": 8,
}


def _round(value: float | None) -> float | None:
    return round(value, 4) if value is not None else None


def _city_state(chain: dict[str, Any], area_pk: int) -> dict[str, Any] | None:
    return next(
        (item for item in chain.get("city_states", []) if item["area_pk"] == area_pk),
        None,
    )


def _demand_for_product(
    planning: dict[str, Any], product_guid: str
) -> dict[str, Any]:
    rows = [
        (group, row)
        for group in planning.get("groups", [])
        for row in group.get("items", [])
        if row["product_guid"] == product_guid and group.get("population_guid") is not None
    ]
    if not rows:
        return {
            "required_rate": None,
            "population": None,
            "production": None,
            "construction": None,
            "other": None,
            "completeness": "not_observed",
            "sources": [],
        }

    population_values = [row.get("population_demand_per_minute") for _, row in rows]
    population_unknown = any(value is None for value in population_values)
    population = sum(float(value) for value in population_values if value is not None)

    sources: dict[str, dict[str, Any]] = {}
    production_unknown = False
    for _, row in rows:
        if row.get("production_input_demand_per_minute") is None:
            production_unknown = True
        for source in row.get("demand_sources", []):
            sources[source["recipe_id"]] = source
    production = sum(float(item.get("rate_per_minute") or 0) for item in sources.values())
    incomplete = population_unknown or production_unknown
    return {
        "required_rate": None if incomplete else population + production,
        "population": None if population_unknown and population == 0 else population,
        "production": None if production_unknown and production == 0 else production,
        "construction": None,
        "other": None,
        "completeness": "partial" if incomplete else "modeled_base",
        "sources": list(sources.values()),
    }


def _resource_category(
    product: dict[str, Any],
    producer_recipes: list[dict[str, Any]],
    used_as_input: bool,
) -> str:
    if product.get("category") == "construction_material":
        return "construction_materials"
    if not producer_recipes or any(
        not any(item["role"] == "input" for item in recipe.get("items", []))
        for recipe in producer_recipes
    ):
        return "raw_materials"
    if used_as_input:
        return "intermediate_goods"
    return "consumer_goods"


def build_production_explorer(
    *,
    chains: dict[str, Any],
    planning: dict[str, Any],
    inventory: dict[str, Any],
    area_pk: int,
    product_guid: str | None,
    recipe_overrides: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Build a city-scoped, upstream production graph from normalized facts.

    The builder is intentionally independent from the presentation layer. It
    propagates the selected city's modeled demand through recipe quantities and
    cycle times while retaining observed factory presence and stock as evidence.
    """
    recipe_overrides = recipe_overrides or {}
    chain_rows = chains.get("chains", [])
    recipes_by_output: dict[str, list[dict[str, Any]]] = defaultdict(list)
    input_products: set[str] = set()
    product_facts: dict[str, dict[str, Any]] = {}
    for chain in chain_rows:
        for item in chain.get("items", []):
            guid = str(item["product_guid"])
            product_facts.setdefault(
                guid,
                {
                    "product_guid": guid,
                    "name": item.get("product_name") or f"Product {guid}",
                    "icon": item.get("product_icon"),
                    "category": item.get("product_category"),
                },
            )
            if item["role"] == "output":
                recipes_by_output[guid].append(chain)
            else:
                input_products.add(guid)

    area_inventory = {
        item["product_guid"]: item
        for item in inventory.get("items", [])
        if item["area_pk"] == area_pk
    }
    for guid, item in area_inventory.items():
        product_facts.setdefault(
            guid,
            {
                "product_guid": guid,
                "name": item["product_name"],
                "icon": None,
                "category": item.get("category"),
            },
        )

    area = planning.get("area", {})
    region_id = REGION_GUID_TO_ID.get(str(area.get("region_guid") or ""))

    def compatible_recipes(guid: str) -> list[dict[str, Any]]:
        candidates = recipes_by_output.get(guid, [])
        if region_id is None:
            return candidates
        return [
            item
            for item in candidates
            if not item.get("associated_regions") or region_id in item["associated_regions"]
        ]

    resource_options = []
    for guid, product in product_facts.items():
        candidates = recipes_by_output.get(guid, [])
        demand = _demand_for_product(planning, guid)
        resource_options.append(
            {
                "product_guid": guid,
                "name": product["name"],
                "icon": product.get("icon"),
                "category": _resource_category(product, candidates, guid in input_products),
                "required_rate": _round(demand["required_rate"]),
                "has_local_recipe": bool(compatible_recipes(guid)),
                "stock": area_inventory.get(guid, {}).get("stock"),
            }
        )
    resource_options.sort(key=lambda item: (item["category"], item["name"]))

    selectable = [item for item in resource_options if item["has_local_recipe"]]
    selected_guid = product_guid if product_guid in product_facts else None
    if selected_guid is None:
        demanded = [item for item in selectable if (item["required_rate"] or 0) > 0]
        selected_guid = (demanded or selectable or resource_options)[0]["product_guid"] if resource_options else None

    resources: dict[str, dict[str, Any]] = {}
    factories: dict[str, dict[str, Any]] = {}
    edges: dict[str, dict[str, Any]] = {}

    def ensure_resource(guid: str, depth: int) -> dict[str, Any]:
        product = product_facts.get(
            guid,
            {"product_guid": guid, "name": f"Product {guid}", "icon": None, "category": None},
        )
        observed = area_inventory.get(guid, {})
        node_id = f"resource:{guid}"
        node = resources.setdefault(
            guid,
            {
                "node_id": node_id,
                "kind": "resource",
                "product_guid": guid,
                "name": product["name"],
                "icon": product.get("icon"),
                "category": product.get("category"),
                "required_accumulator": 0.0,
                "unknown_required": False,
                "stock": observed.get("stock"),
                "capacity": observed.get("capacity"),
                "stock_trend": (observed.get("velocity") or {}).get("net_stock_change_per_minute"),
                "trend_confidence": (observed.get("velocity") or {}).get("confidence"),
                "depth": depth,
                "producer_factory_id": None,
                "producer_state": "not_selected",
                "cycle_detected": False,
                "status": "unknown",
                "alerts": [],
            },
        )
        node["depth"] = min(node["depth"], depth)
        return node

    def add_edge(
        source: str,
        target: str,
        kind: str,
        rate: float | None,
        recipe_amount: float,
    ) -> None:
        edge_id = f"{source}>{target}"
        edge = edges.setdefault(
            edge_id,
            {
                "edge_id": edge_id,
                "source": source,
                "target": target,
                "kind": kind,
                "recipe_amount": recipe_amount,
                "required_accumulator": 0.0,
                "unknown_required": False,
            },
        )
        if rate is None:
            edge["unknown_required"] = True
        else:
            edge["required_accumulator"] += rate

    def candidate_sort_key(chain: dict[str, Any]) -> tuple[int, float, str]:
        state = _city_state(chain, area_pk)
        count = float(state.get("building_count") or 0) if state else 0.0
        installed_rank = 0 if state and state.get("presence_status") == "installed" and count > 0 else 1
        return installed_rank, -count, str(chain["recipe_id"])

    def choose_recipe(guid: str) -> tuple[dict[str, Any] | None, list[dict[str, Any]], str]:
        all_candidates = recipes_by_output.get(guid, [])
        candidates = compatible_recipes(guid)
        if not candidates:
            return None, all_candidates, "unavailable_in_region" if all_candidates else "no_recipe"
        override = recipe_overrides.get(guid)
        selected = next((item for item in candidates if item["recipe_id"] == override), None)
        return selected or sorted(candidates, key=candidate_sort_key)[0], candidates, "selected"

    def expand(guid: str, rate: float | None, depth: int, path: tuple[str, ...]) -> None:
        resource = ensure_resource(guid, depth)
        if rate is None:
            resource["unknown_required"] = True
        else:
            resource["required_accumulator"] += rate
        if guid in path:
            resource["cycle_detected"] = True
            resource["producer_state"] = "cycle_detected"
            return

        chosen, candidates, producer_state = choose_recipe(guid)
        resource["producer_state"] = producer_state
        if chosen is None:
            return
        output = next(
            (item for item in chosen["items"] if item["role"] == "output" and str(item["product_guid"]) == guid),
            None,
        )
        cycle_seconds = chosen.get("cycle_seconds")
        if output is None or cycle_seconds is None or cycle_seconds <= 0 or output["amount"] <= 0:
            resource["producer_state"] = "invalid_recipe"
            return
        output_per_minute = float(output["amount"]) * 60.0 / float(cycle_seconds)
        factory_id = f"factory:{chosen['recipe_id']}:{guid}"
        state = _city_state(chosen, area_pk)
        installed = state.get("building_count") if state else None
        presence = state.get("presence_status") if state else "unknown"
        alternatives = []
        for candidate in sorted(candidates, key=candidate_sort_key):
            candidate_output = next(
                item for item in candidate["items"]
                if item["role"] == "output" and str(item["product_guid"]) == guid
            )
            candidate_cycle = candidate.get("cycle_seconds")
            candidate_state = _city_state(candidate, area_pk)
            alternatives.append(
                {
                    "recipe_id": candidate["recipe_id"],
                    "building_guid": candidate["building_guid"],
                    "building_name": candidate.get("building_name") or candidate["name"],
                    "output_per_minute": _round(
                        float(candidate_output["amount"]) * 60.0 / float(candidate_cycle)
                        if candidate_cycle and candidate_cycle > 0 else None
                    ),
                    "installed_buildings": candidate_state.get("building_count") if candidate_state else None,
                    "presence_status": candidate_state.get("presence_status") if candidate_state else "unknown",
                    "selected": candidate["recipe_id"] == chosen["recipe_id"],
                }
            )
        factory = factories.setdefault(
            factory_id,
            {
                "node_id": factory_id,
                "kind": "factory",
                "recipe_id": chosen["recipe_id"],
                "building_guid": chosen["building_guid"],
                "building_name": chosen.get("building_name") or chosen["name"],
                "building_icon": chosen.get("building_icon"),
                "workforce_guid": chosen.get("workforce_guid"),
                "workforce_name": chosen.get("workforce_name"),
                "cycle_seconds": cycle_seconds,
                "output_product_guid": guid,
                "output_amount": output["amount"],
                "output_per_minute_per_building": output_per_minute,
                "required_accumulator": 0.0,
                "unknown_required": False,
                "installed_buildings": installed,
                "presence_status": presence,
                "base_maintenance": chosen.get("base_maintenance"),
                "depth": depth + 1,
                "alternatives": alternatives,
                "status": "unknown",
            },
        )
        resource["producer_factory_id"] = factory_id
        if rate is None:
            factory["unknown_required"] = True
        else:
            factory["required_accumulator"] += rate
        add_edge(resource["node_id"], factory_id, "produced_by", rate, float(output["amount"]))

        for item in sorted(
            (item for item in chosen["items"] if item["role"] == "input"),
            key=lambda item: item["ordinal"],
        ):
            input_guid = str(item["product_guid"])
            input_rate = None if rate is None else rate * float(item["amount"]) / float(output["amount"])
            input_resource = ensure_resource(input_guid, depth + 2)
            add_edge(
                factory_id,
                input_resource["node_id"],
                "requires",
                input_rate,
                float(item["amount"]),
            )
            expand(input_guid, input_rate, depth + 2, (*path, guid))

    demand = _demand_for_product(planning, selected_guid) if selected_guid else {
        "required_rate": None,
        "population": None,
        "production": None,
        "construction": None,
        "other": None,
        "completeness": "not_observed",
        "sources": [],
    }
    if selected_guid:
        expand(selected_guid, demand["required_rate"], 0, ())

    signals_by_product: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for signal in inventory.get("signals", []):
        if signal["area_pk"] == area_pk:
            signals_by_product[signal["product_guid"]].append(signal)

    for factory in factories.values():
        required_rate = None if factory.pop("unknown_required") else factory.pop("required_accumulator")
        per_building = float(factory["output_per_minute_per_building"])
        required_buildings = required_rate / per_building if required_rate is not None else None
        installed = factory["installed_buildings"]
        available_rate = installed * per_building if installed is not None else None
        balance_rate = available_rate - required_rate if available_rate is not None and required_rate is not None else None
        balance_buildings = installed - required_buildings if installed is not None and required_buildings is not None else None
        if required_buildings is None or installed is None:
            status = "unknown"
        elif required_buildings <= 0:
            status = "neutral"
        elif installed <= 0:
            status = "missing"
        elif installed + 1e-9 < required_buildings:
            status = "deficit"
        elif installed - required_buildings < max(0.1, required_buildings * 0.1):
            status = "constrained"
        else:
            status = "healthy"
        factory.update(
            {
                "required_output_rate": _round(required_rate),
                "required_buildings": _round(required_buildings),
                "buildings_needed": math.ceil(required_buildings) if required_buildings is not None else None,
                "available_output_rate": _round(available_rate),
                "capacity_balance_rate": _round(balance_rate),
                "capacity_balance_buildings": _round(balance_buildings),
                "utilization": _round(required_buildings / installed) if installed and required_buildings is not None else None,
                "status": status,
            }
        )

    for resource in resources.values():
        required_rate = None if resource.pop("unknown_required") else resource.pop("required_accumulator")
        factory = factories.get(resource.get("producer_factory_id"))
        alerts = signals_by_product.get(resource["product_guid"], [])
        alert_codes = {item["code"] for item in alerts}
        if resource["cycle_detected"]:
            status = "unknown"
        elif factory is not None:
            status = factory["status"]
            if status in {"healthy", "neutral"} and alert_codes & {"low_stock", "falling_stock", "estimated_stockout"}:
                status = "risk"
        elif resource["producer_state"] == "unavailable_in_region" and (required_rate or 0) > 0:
            status = "import_required"
        elif resource["producer_state"] == "no_recipe":
            status = "raw"
        else:
            status = "unknown"
        resource.update(
            {
                "required_rate": _round(required_rate),
                "status": status,
                "alerts": [
                    {"code": item["code"], "severity": item["severity"], "label": item["label"]}
                    for item in alerts
                ],
            }
        )

    for edge in edges.values():
        edge["required_rate"] = None if edge.pop("unknown_required") else _round(edge.pop("required_accumulator"))

    root_resource = resources.get(selected_guid or "")
    root_factory = factories.get(root_resource.get("producer_factory_id")) if root_resource else None
    bottlenecks = sorted(
        [
            {
                "node_id": node["node_id"],
                "kind": node["kind"],
                "name": node.get("name") or node.get("building_name"),
                "status": node["status"],
            }
            for node in [*resources.values(), *factories.values()]
            if node["status"] in {"missing", "deficit", "constrained", "risk", "import_required", "unknown"}
        ],
        key=lambda item: (STATUS_ORDER[item["status"]], item["name"]),
    )
    summary_status = bottlenecks[0]["status"] if bottlenecks else "healthy"

    return {
        "meta": inventory["meta"],
        "catalog": inventory["catalog"],
        "area": area,
        "root_product_guid": selected_guid,
        "resource_options": resource_options,
        "demand": {
            key: _round(value) if isinstance(value, float) else value
            for key, value in demand.items()
            if key != "sources"
        } | {"sources": demand.get("sources", [])},
        "resources": sorted(resources.values(), key=lambda item: (item["depth"], item["name"])),
        "factories": sorted(factories.values(), key=lambda item: (item["depth"], item["building_name"])),
        "edges": sorted(edges.values(), key=lambda item: item["edge_id"]),
        "summary": {
            "required_rate": _round(demand["required_rate"]),
            "available_rate": root_factory.get("available_output_rate") if root_factory else None,
            "capacity_balance_rate": root_factory.get("capacity_balance_rate") if root_factory else None,
            "required_buildings": root_factory.get("required_buildings") if root_factory else None,
            "installed_buildings": root_factory.get("installed_buildings") if root_factory else None,
            "status": summary_status,
            "bottleneck_count": len(bottlenecks),
            "bottlenecks": bottlenecks,
        },
        "capabilities": {
            "catalog_recipe_rates": True,
            "observed_installed_buildings": True,
            "observed_stock": True,
            "observed_productivity_modifiers": False,
            "construction_demand": False,
            "active_project_demand": False,
        },
        "measurement_notice": (
            "Required throughput uses the City Stock Planning base demand model. Available rate is catalog base capacity from observed building counts; productivity buffs are not observed. Stock movement remains secondary evidence."
        ),
    }
