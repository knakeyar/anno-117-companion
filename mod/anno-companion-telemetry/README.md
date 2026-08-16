# Anno Companion Telemetry 1.1.0

This is the read-only production telemetry emitter used by the Anno Companion data service. It does not change game state and does not attempt direct file access.

Install the entire `anno-companion-telemetry` folder under the Anno 117 Documents `mods` directory. Keep the research probe disabled while this mod is enabled.

The mod emits records beginning with:

```text
ANNO_COMPANION_TELEMETRY_JSON 
```

It emits a full baseline after each load, change-only snapshots every 30 seconds of advancing game time, and a full reconciliation every 10 game minutes. Inventory is chunked in groups of 16 goods and building presence in groups of 32 catalog entries. Population, area finance, passive-trade flags, participant finance, route issues, current-camera-area workforce, and optional Kontor coordinates are included when readable. Missing capabilities are emitted as structured section errors rather than zero values.

The product and building allowlists are generated from `catalog/anno117-community-2.1-c6a6e752.json`. Run `python tools/generate_catalog.py` from the repository root after changing the catalog.
