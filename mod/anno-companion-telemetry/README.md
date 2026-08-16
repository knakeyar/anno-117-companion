# Anno Companion Telemetry 1.0.0

This is the read-only production telemetry emitter used by the Anno Companion data service. It does not change game state and does not attempt direct file access.

Install the entire `anno-companion-telemetry` folder under the Anno 117 Documents `mods` directory. Keep the research probe disabled while this mod is enabled.

The mod emits records beginning with:

```text
ANNO_COMPANION_TELEMETRY_JSON 
```

It takes a full inventory snapshot of every controlled area every 30 seconds of advancing game time. Population, area finance, passive-trade flags, participant finance, route issues, and current-camera-area workforce are included when readable. Missing capabilities are emitted as structured section errors rather than zero values.

The product allowlist is generated from `catalog/starter-catalog.json`. Run `python tools/generate_catalog.py` from the repository root after changing the catalog.

