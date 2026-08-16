from __future__ import annotations

import hashlib
import json
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import (
    BuildingType,
    Product,
    ProductionRecipe,
    ProductionRecipeItem,
    StaticRelease,
)


class CatalogError(RuntimeError):
    pass


def load_catalog(session: Session, path: Path) -> StaticRelease:
    source = path.read_bytes()
    source_hash = hashlib.sha256(source).hexdigest()
    data = json.loads(source)
    release_id = str(data["release_id"])

    existing = session.get(StaticRelease, release_id)
    if existing is not None:
        if existing.source_hash != source_hash:
            raise CatalogError(
                f"catalog release {release_id!r} changed without a new release_id"
            )
        return existing

    release = StaticRelease(
        release_id=release_id,
        label=str(data["label"]),
        game_version=data.get("game_version"),
        source_hash=source_hash,
        coverage_note=data.get("coverage_note"),
    )
    session.add(release)
    session.flush()

    product_guids: set[str] = set()
    for item in data.get("products", []):
        guid = str(item["guid"])
        if guid in product_guids:
            raise CatalogError(f"duplicate product GUID {guid}")
        product_guids.add(guid)
        session.add(
            Product(
                release_id=release_id,
                product_guid=guid,
                name=str(item["name"]),
                category=item.get("category"),
                icon=item.get("icon"),
                telemetry_enabled=bool(item.get("telemetry_enabled", True)),
            )
        )

    building_guids: set[str] = set()
    for item in data.get("building_types", []):
        guid = str(item["guid"])
        if guid in building_guids:
            raise CatalogError(f"duplicate building GUID {guid}")
        building_guids.add(guid)
        session.add(
            BuildingType(
                release_id=release_id,
                building_guid=guid,
                name=str(item["name"]),
                icon=item.get("icon"),
                workforce_guid=(str(item["workforce_guid"]) if item.get("workforce_guid") else None),
            )
        )

    recipe_ids: set[str] = set()
    for recipe in data.get("recipes", []):
        recipe_id = str(recipe["recipe_id"])
        building_guid = str(recipe["building_guid"])
        if recipe_id in recipe_ids:
            raise CatalogError(f"duplicate recipe ID {recipe_id}")
        if building_guid not in building_guids:
            raise CatalogError(f"recipe {recipe_id} references unknown building {building_guid}")
        recipe_ids.add(recipe_id)
        session.add(
            ProductionRecipe(
                release_id=release_id,
                recipe_id=recipe_id,
                building_guid=building_guid,
                name=recipe.get("name"),
                cycle_seconds=(float(recipe["cycle_seconds"]) if recipe.get("cycle_seconds") else None),
            )
        )
        for ordinal, item in enumerate(recipe.get("items", []), start=1):
            product_guid = str(item["product_guid"])
            role = str(item["role"])
            if role not in {"input", "output"}:
                raise CatalogError(f"recipe {recipe_id} has invalid role {role}")
            if product_guid not in product_guids:
                raise CatalogError(f"recipe {recipe_id} references unknown product {product_guid}")
            session.add(
                ProductionRecipeItem(
                    release_id=release_id,
                    recipe_id=recipe_id,
                    role=role,
                    ordinal=ordinal,
                    product_guid=product_guid,
                    amount=float(item["amount"]),
                )
            )
    session.commit()
    return release


def catalog_summary(session: Session, release_id: str | None = None) -> dict:
    if release_id is None:
        release = session.scalars(
            select(StaticRelease).order_by(StaticRelease.imported_at.desc())
        ).first()
    else:
        release = session.get(StaticRelease, release_id)
    if release is None:
        return {"release_id": None, "products": 0, "recipes": 0, "coverage": "missing"}
    products = len(session.scalars(select(Product).where(Product.release_id == release.release_id)).all())
    recipes = len(
        session.scalars(
            select(ProductionRecipe).where(ProductionRecipe.release_id == release.release_id)
        ).all()
    )
    return {
        "release_id": release.release_id,
        "label": release.label,
        "source_hash": release.source_hash,
        "products": products,
        "recipes": recipes,
        "coverage": "starter" if recipes == 0 else "partial",
        "coverage_note": release.coverage_note,
    }
