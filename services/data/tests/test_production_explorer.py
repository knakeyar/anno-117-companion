from app.production_explorer import build_production_explorer


def _chain(
    recipe_id: str,
    building_guid: str,
    building_name: str,
    cycle_seconds: float,
    output: tuple[str, str, float],
    inputs: list[tuple[str, str, float]],
    *,
    installed: float | None,
) -> dict:
    return {
        "recipe_id": recipe_id,
        "name": building_name,
        "building_guid": building_guid,
        "building_name": building_name,
        "building_icon": None,
        "workforce_guid": "workforce",
        "workforce_name": "Plebeian Workforce",
        "cycle_seconds": cycle_seconds,
        "items": [
            {
                "role": "output",
                "ordinal": 0,
                "product_guid": output[0],
                "product_name": output[1],
                "product_icon": None,
                "product_category": None,
                "amount": output[2],
            },
            *[
                {
                    "role": "input",
                    "ordinal": ordinal,
                    "product_guid": item[0],
                    "product_name": item[1],
                    "product_icon": None,
                    "product_category": None,
                    "amount": item[2],
                }
                for ordinal, item in enumerate(inputs, start=1)
            ],
        ],
        "associated_regions": ["Roman"],
        "base_maintenance": 10,
        "city_states": [{
            "area_pk": 1,
            "area_name": "Agathea",
            "region_guid": "3225",
            "building_count": installed,
            "presence_status": "installed" if installed else "not_installed",
        }],
    }


def _facts() -> tuple[dict, dict, dict]:
    chains = {
        "catalog": {},
        "chains": [
            _chain("factory:soap", "soap-maker", "Soap Maker", 60, ("soap", "Soap", 2), [("lard", "Lard", 1), ("lavender", "Lavender", 2)], installed=1),
            _chain("factory:soap-alt", "soap-maker-alt", "Efficient Soap Maker", 60, ("soap", "Soap", 4), [("lard", "Lard", 1)], installed=0),
            _chain("factory:lard", "pig-farm", "Pig Farm", 30, ("lard", "Lard", 1), [("pigs", "Pigs", 2)], installed=1),
            _chain("factory:lavender", "lavender-farm", "Lavender Farm", 60, ("lavender", "Lavender", 1), [], installed=5),
        ],
    }
    planning = {
        "area": {
            "area_pk": 1,
            "area_name": "Agathea",
            "region_guid": "3225",
            "population_total": 10_000,
            "residence_count": 1_000,
        },
        "groups": [{
            "population_guid": "plebeians",
            "items": [{
                "product_guid": "soap",
                "population_demand_per_minute": 4.0,
                "production_input_demand_per_minute": 0.0,
                "demand_sources": [],
            }],
        }],
    }
    inventory = {
        "meta": {"snapshot_id": 1},
        "catalog": {"release_id": "test"},
        "signals": [],
        "items": [
            {
                "area_pk": 1,
                "product_guid": guid,
                "product_name": name,
                "stock": stock,
                "capacity": 500,
                "velocity": None,
            }
            for guid, name, stock in [
                ("soap", "Soap", 240),
                ("lard", "Lard", 80),
                ("lavender", "Lavender", 100),
                ("pigs", "Pigs", 40),
            ]
        ],
    }
    return chains, planning, inventory


def test_builds_branching_chain_and_propagates_actual_recipe_quantities() -> None:
    chains, planning, inventory = _facts()
    result = build_production_explorer(
        chains=chains,
        planning=planning,
        inventory=inventory,
        area_pk=1,
        product_guid="soap",
    )

    resources = {item["product_guid"]: item for item in result["resources"]}
    factories = {item["recipe_id"]: item for item in result["factories"]}
    assert result["root_product_guid"] == "soap"
    assert result["demand"]["required_rate"] == 4
    assert resources["soap"]["required_rate"] == 4
    assert resources["lard"]["required_rate"] == 2
    assert resources["lavender"]["required_rate"] == 4
    assert resources["pigs"]["required_rate"] == 4
    assert factories["factory:soap"]["output_per_minute_per_building"] == 2
    assert factories["factory:soap"]["required_buildings"] == 2
    assert factories["factory:soap"]["installed_buildings"] == 1
    assert factories["factory:soap"]["status"] == "deficit"
    assert factories["factory:lard"]["required_buildings"] == 1
    assert factories["factory:lavender"]["required_buildings"] == 4
    assert len([edge for edge in result["edges"] if edge["source"] == "factory:factory:soap:soap"]) == 2


def test_exact_recipe_override_recalculates_the_entire_upstream_chain() -> None:
    chains, planning, inventory = _facts()
    result = build_production_explorer(
        chains=chains,
        planning=planning,
        inventory=inventory,
        area_pk=1,
        product_guid="soap",
        recipe_overrides={"soap": "factory:soap-alt"},
    )

    resources = {item["product_guid"]: item for item in result["resources"]}
    factory = result["factories"][0]
    assert factory["recipe_id"] == "factory:soap-alt"
    assert factory["required_buildings"] == 1
    assert resources["lard"]["required_rate"] == 1
    assert "lavender" not in resources
    assert next(item for item in factory["alternatives"] if item["recipe_id"] == "factory:soap-alt")["selected"] is True


def test_unknown_demand_component_is_not_presented_as_a_complete_rate() -> None:
    chains, planning, inventory = _facts()
    planning["groups"][0]["items"][0]["population_demand_per_minute"] = None
    result = build_production_explorer(
        chains=chains,
        planning=planning,
        inventory=inventory,
        area_pk=1,
        product_guid="soap",
    )

    assert result["demand"]["required_rate"] is None
    assert result["demand"]["completeness"] == "partial"
    assert result["summary"]["required_rate"] is None
    assert all(item["required_output_rate"] is None for item in result["factories"])
