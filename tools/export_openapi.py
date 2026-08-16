#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path


REPOSITORY = Path(__file__).resolve().parents[1]
DATA_SERVICE = REPOSITORY / "services" / "data"
OUTPUT = REPOSITORY / "apps" / "dashboard" / "openapi.json"
sys.path.insert(0, str(DATA_SERVICE))
os.environ.setdefault(
    "ANNO_DATABASE_PATH", str(Path(tempfile.gettempdir()) / "anno-companion-openapi.sqlite3")
)
os.environ.setdefault("ANNO_ENABLE_TAILER", "false")

from app.main import app  # noqa: E402


def rendered_schema() -> str:
    return json.dumps(app.openapi(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Export the dashboard's pinned API contract")
    parser.add_argument("--check", action="store_true", help="fail if openapi.json is stale")
    args = parser.parse_args()
    rendered = rendered_schema()
    if args.check:
        if not OUTPUT.is_file() or OUTPUT.read_text(encoding="utf-8") != rendered:
            print(f"{OUTPUT.relative_to(REPOSITORY)} is stale; run npm run generate:api")
            return 1
        return 0
    OUTPUT.write_text(rendered, encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(REPOSITORY)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
