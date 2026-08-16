#!/usr/bin/env python3
"""Extract the pinned calculator's population-planning facts without game artwork."""

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


def make_planning_catalog(params: dict) -> dict:
    products = {str(item["guid"]): item for item in params["products"]}
    needs = {str(item["guid"]): item for item in params["needs"]}
    levels = {str(item["guid"]): item for item in params["populationLevels"]}
    population_levels: list[dict] = []

    for residence in params["residenceBuildings"]:
        level_guid = str(residence["populationLevel"])
        level = levels[level_guid]
        need_rows = []
        maximum_population = 0.0
        for configured_need in residence.get("needsList", []):
            need = needs[str(configured_need["need"])]
            maximum_population += float((need.get("needAttributes") or {}).get("Population") or 0)
            rate = configured_need.get("needConsumptionRate")
            if rate is None:
                continue
            product_guid = str(need["needProduct"])
            product = products.get(product_guid)
            if product is None:
                raise ValueError(f"population need references unknown product {product_guid}")
            need_rows.append(
                {
                    "need_guid": str(need["guid"]),
                    "product_guid": product_guid,
                    "product_name": english(product),
                    "base_consumption_per_residence_minute": float(rate),
                }
            )
        if maximum_population <= 0:
            raise ValueError(f"residence {residence['guid']} has no population capacity")
        population_levels.append(
            {
                "population_guid": level_guid,
                "name": english(level),
                "workforce_guid": str(level["connectedWorkforce"]),
                "associated_regions": level.get("associatedRegions", []),
                "residence_guid": str(residence["guid"]),
                "residence_name": english(residence),
                "maximum_population_per_residence": maximum_population,
                "needs": need_rows,
            }
        )

    factors = {
        str(item["id"]): float(item["consumptionFactor"])
        for item in params.get("needConsumptions", [])
    }
    if factors != {"Low": 1.0, "Medium": 1.25, "High": 1.5}:
        raise ValueError(f"pinned consumption factors changed: {factors}")
    if len(population_levels) != 9:
        raise ValueError("pinned population-level count changed")

    return {
        "release_id": RELEASE_ID,
        "source_url": SOURCE_URL,
        "source_revision": REVISION,
        "attribution": "Population need rates derived from anno-mods/anno-117-calculator; no icon binaries are bundled.",
        "measurement_notice": "Catalog base demand per residence. Runtime modifiers and individual need activation are not observed.",
        "consumption_factors": factors,
        "population_levels": population_levels,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True, help="Pinned calculator js/params.js")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("catalog/anno117-community-2.1-c6a6e752-planning.json"),
    )
    args = parser.parse_args()
    rendered = json.dumps(make_planning_catalog(read_params(args.source)), ensure_ascii=False, indent=2) + "\n"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(rendered, encoding="utf-8")


if __name__ == "__main__":
    main()
