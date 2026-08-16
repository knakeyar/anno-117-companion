from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.catalog import CatalogError, catalog_summary, load_catalog


def test_starter_catalog_is_visible_and_immutable(session_factory, catalog_path: Path, tmp_path: Path) -> None:
    with session_factory() as session:
        summary = catalog_summary(session)
        assert summary["release_id"] == "anno117-v1-starter"
        assert summary["products"] == 3
        assert summary["recipes"] == 0
        assert summary["coverage"] == "starter"

        changed = json.loads(catalog_path.read_text())
        changed["label"] = "mutated without version"
        changed_path = tmp_path / "changed.json"
        changed_path.write_text(json.dumps(changed))
        with pytest.raises(CatalogError, match="changed without a new release_id"):
            load_catalog(session, changed_path)
