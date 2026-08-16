#!/usr/bin/env python3
"""Create the pinned Anno 117 community catalog without bundling game assets."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

RELEASE_ID = "anno117-community-2.1-c6a6e752"
REVISION = "c6a6e7525d16927f74d4f554dde5831b84fa287c"
SOURCE_URL = f"https://github.com/anno-mods/anno-117-calculator/tree/{REVISION}"


def read_params(path: Path) -> dict:
    source = path.read_text(encoding="utf-8")
    marker = "window.params="
    start = source.find(marker)
    if start < 0:
        raise ValueError("params.js does not assign window.params")
    start = source.find("{", start + len(marker))
    value, _ = json.JSONDecoder().raw_decode(source[start:])
    return value


def english(item: dict) -> str:
    return str((item.get("locaText") or {}).get("english") or item.get("name") or item["guid"])


def make_catalog(params: dict) -> dict:
    economic_guids = {
        str(item["product"])
        for factory in params["factories"]
        for role in ("inputs", "outputs")
        for item in factory.get(role, [])
    }
    products = []
    product_guids = {str(item["guid"]) for item in params["products"]}
    for item in params["products"]:
        guid = str(item["guid"])
        products.append(
            {
                "guid": guid,
                "name": english(item),
                "category": "construction_material" if item.get("isConstructionMaterial") else "economic_good" if guid in economic_guids else "reference",
                "telemetry_enabled": guid in economic_guids,
                "associated_regions": item.get("associatedRegions", []),
                "dlc_unlocks": [str(value) for value in item.get("dlcUnlocks", [])],
                "icon": None,
            }
        )

    building_types = []
    recipes = []
    maintenance_items = []
    for factory in params["factories"]:
        guid = str(factory["guid"])
        workforce = next(
            (
                str(item["product"])
                for item in factory.get("maintenances", [])
                if str(item["product"]) != "1010017"
            ),
            None,
        )
        building_types.append(
            {
                "guid": guid,
                "name": english(factory),
                "workforce_guid": workforce,
                "associated_regions": factory.get("associatedRegions", []),
                "dlc_unlocks": [str(value) for value in factory.get("dlcUnlocks", [])],
                "icon": None,
            }
        )
        recipe_items = []
        for role in ("inputs", "outputs"):
            for item in factory.get(role, []):
                recipe_items.append(
                    {
                        "role": role[:-1],
                        "product_guid": str(item["product"]),
                        "amount": float(item["amount"]),
                    }
                )
        recipes.append(
            {
                "recipe_id": f"factory:{guid}",
                "building_guid": guid,
                "name": english(factory),
                "cycle_seconds": float(factory.get("cycleTime") or 0),
                "items": recipe_items,
            }
        )
        for item in factory.get("maintenances", []):
            product_guid = str(item["product"])
            maintenance_items.append(
                {
                    "building_guid": guid,
                    "product_guid": product_guid,
                    "amount": float(item["amount"]),
                    "kind": "money" if product_guid == "1010017" else "workforce_or_product",
                }
            )

    referenced = {
        item["product_guid"]
        for recipe in recipes
        for item in recipe["items"]
    }
    if not referenced <= product_guids:
        raise ValueError(f"unknown product references: {sorted(referenced - product_guids)}")
    if (len(products), len(economic_guids), len(building_types), len(recipes)) != (145, 113, 144, 144):
        raise ValueError("pinned source counts changed")

    region_by_id = {item["id"]: item for item in params["regions"]}
    sessions = {
        str(item["region"]): str(item["guid"])
        for item in params["sessions"]
    }
    regions = [
        {
            "id": item["id"],
            "guid": str(item["guid"]),
            "session_guid": sessions.get(str(item["guid"])),
            "name": english(item),
        }
        for item in region_by_id.values()
    ]
    return {
        "release_id": RELEASE_ID,
        "label": "Anno 117 Community Calculator 2.1",
        "game_version": "2.1",
        "source_url": SOURCE_URL,
        "source_revision": REVISION,
        "source_license": "MIT (calculator code); game names and balancing remain Ubisoft property",
        "attribution": "Derived from anno-mods/anno-117-calculator. No proprietary icon binaries are bundled.",
        "coverage_note": "145 reference products; inventory telemetry enabled for 113 factory inputs/outputs; 144 factory recipes.",
        "regions": regions,
        "products": sorted(products, key=lambda value: (value["name"], value["guid"])),
        "building_types": sorted(building_types, key=lambda value: (value["name"], value["guid"])),
        "recipes": sorted(recipes, key=lambda value: (value["name"], value["recipe_id"])),
        "maintenance_items": maintenance_items,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True, help="Pinned calculator js/params.js")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("catalog/anno117-community-2.1-c6a6e752.json"),
    )
    args = parser.parse_args()
    rendered = json.dumps(make_catalog(read_params(args.source)), ensure_ascii=False, indent=2) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered, encoding="utf-8")


if __name__ == "__main__":
    main()
