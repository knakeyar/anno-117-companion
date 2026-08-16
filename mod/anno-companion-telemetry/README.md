# Anno Companion Telemetry 1.1.4

This is the read-only production telemetry emitter used by the Anno Companion data service. It does not change game state and does not attempt direct file access.

Install the entire `anno-companion-telemetry` folder under the Anno 117 Documents `mods` directory. Keep the research probe disabled while this mod is enabled.

The mod emits records beginning with:

```text
ANNO_COMPANION_TELEMETRY_JSON 
```

It emits a full baseline after 10 seconds of advancing game time, change-only snapshots every 30 seconds after that, and a full reconciliation every 10 game minutes. Inventory is chunked in groups of 16 goods and building presence in groups of 32 catalog entries. Population, residence and factory counts, need-consumption difficulty, area finance, passive-trade flags, participant finance, route issues, assigned route ships, current-camera-area workforce, and optional Kontor coordinates are included when readable. Missing capabilities are emitted as structured section errors rather than zero values.

Assigned route ships include the player-visible ship name when readable, immutable observation ID, mutable route name, and paused/running state. The validated bindings do not expose a stable route ID, configured stops, configured goods, or reliable ship cargo, so the companion keeps those details explicitly unknown.

The product and factory allowlists are generated from `catalog/anno117-community-2.1-c6a6e752.json`; the nine residence types used by city capacity planning come from the matching `-planning.json` supplement. Run `python tools/generate_catalog.py` from the repository root after changing either catalog.
