#!/usr/bin/env python3
"""Validate the shared catalog and generate the Lua telemetry allowlist."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def lua_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def validate(catalog: dict) -> None:
    required = {"release_id", "label", "products", "building_types", "recipes"}
    missing = required - catalog.keys()
    if missing:
        raise ValueError(f"catalog is missing: {', '.join(sorted(missing))}")

    product_ids: set[str] = set()
    for product in catalog["products"]:
        guid = str(product["guid"])
        if guid in product_ids:
            raise ValueError(f"duplicate product GUID: {guid}")
        product_ids.add(guid)

    building_ids = {str(item["guid"]) for item in catalog["building_types"]}
    recipe_ids: set[str] = set()
    for recipe in catalog["recipes"]:
        recipe_id = str(recipe["recipe_id"])
        if recipe_id in recipe_ids:
            raise ValueError(f"duplicate recipe ID: {recipe_id}")
        recipe_ids.add(recipe_id)
        if str(recipe["building_guid"]) not in building_ids:
            raise ValueError(f"recipe {recipe_id} references an unknown building")
        for item in recipe.get("items", []):
            if item["role"] not in {"input", "output"}:
                raise ValueError(f"recipe {recipe_id} has invalid item role")
            if str(item["product_guid"]) not in product_ids:
                raise ValueError(f"recipe {recipe_id} references an unknown product")
    for item in catalog.get("maintenance_items", []):
        if str(item["building_guid"]) not in building_ids:
            raise ValueError("maintenance references an unknown building")
        # Workforce maintenance GUIDs live in a separate runtime namespace and
        # therefore need not appear in the product reference list.


def validate_planning_catalog(catalog: dict, planning_catalog: dict) -> None:
    if planning_catalog.get("release_id") != catalog["release_id"]:
        raise ValueError("planning catalog release does not match the economy catalog")
    factory_ids = {str(item["guid"]) for item in catalog["building_types"]}
    residence_ids: set[str] = set()
    for level in planning_catalog.get("population_levels", []):
        residence_guid = str(level["residence_guid"])
        if residence_guid in factory_ids or residence_guid in residence_ids:
            raise ValueError(f"duplicate planning residence GUID: {residence_guid}")
        residence_ids.add(residence_guid)


def render_lua(catalog: dict, source_hash: str, planning_catalog: dict | None = None) -> str:
    enabled = [item for item in catalog["products"] if item.get("telemetry_enabled", True)]
    product_lines = [
        "        { guid = %s, name = %s }," % (int(item["guid"]), lua_string(item["name"]))
        for item in enabled
    ]
    building_lines = [
        "        { guid = %s, name = %s }," % (int(item["guid"]), lua_string(item["name"]))
        for item in catalog["building_types"]
    ]
    if planning_catalog is not None:
        building_lines.extend(
            "        { guid = %s, name = %s, kind = \"residence\" },"
            % (int(item["residence_guid"]), lua_string(item["residence_name"]))
            for item in planning_catalog.get("population_levels", [])
        )
    region_lines = [
        "        { guid = %s, session_guid = %s, name = %s },"
        % (int(item["guid"]), int(item["session_guid"]), lua_string(item["name"]))
        for item in catalog.get("regions", [])
        if item.get("session_guid") is not None
    ]
    return "\n".join(
        [
            f"-- Generated from catalog/{catalog['release_id']}.json. Do not edit by hand.",
            "return {",
            f"    release_id = {lua_string(catalog['release_id'])},",
            f"    source_hash = {lua_string(source_hash)},",
            "    products = {",
            *product_lines,
            "    },",
            "    buildings = {",
            *building_lines,
            "    },",
            "    regions = {",
            *region_lines,
            "    },",
            "}",
            "",
        ]
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--catalog",
        type=Path,
        default=Path("catalog/anno117-community-2.1-c6a6e752.json"),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("mod/anno-companion-telemetry/anno-companion/catalog.lua"),
    )
    parser.add_argument(
        "--planning-catalog",
        type=Path,
        default=Path("catalog/anno117-community-2.1-c6a6e752-planning.json"),
    )
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()

    source = args.catalog.read_bytes()
    catalog = json.loads(source)
    validate(catalog)
    planning_catalog = json.loads(args.planning_catalog.read_text(encoding="utf-8"))
    validate_planning_catalog(catalog, planning_catalog)
    rendered = render_lua(catalog, hashlib.sha256(source).hexdigest(), planning_catalog)

    if args.check:
        if not args.output.exists() or args.output.read_text() != rendered:
            raise SystemExit(f"{args.output} is out of date; run {Path(__file__).name}")
        return

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered)


if __name__ == "__main__":
    main()
