# Anno Companion Focused Scope Probe 0.4.0

This is the second, smaller read-only runtime test. The first broad run established that log transport, controlled-area enumeration, inventory, population, finance, trade-route issues, ships, and factories are reachable. This version focuses on the remaining scope questions that affect the stable v1 data model.

It does not modify game state. Normal UI actions performed by the player are the only changes used during the test.

## What it records

Every sample emits a small group of JSON records with this prefix:

```text
ANNO_COMPANION_PROBE_JSON 
```

The records cover:

- campaign/session/region identity evidence and game clocks;
- all controlled-area IDs and names for cross-region comparison;
- current area, UI-selected area, and statistics selected-area count;
- stock and passive-trade settings for timber, tiles, and concrete on one controlled target area;
- production/consumption statistics for those products;
- workforce supply, demand, and balance candidates;
- four statistics-history indices.
- Kontor `Position2D`/session identity and building-count bindings for every controlled area.
- current-session island IDs, template filenames, bounding rectangles, and active rectangles for the real regional map layout.

The target area is chosen in this order:

1. UI-selected area, if it is controlled by the player;
2. current camera area, if it is controlled by the player;
3. the first controlled area as an explicit fallback.

The `target_area_reason` field states which rule was used.

## Install/update

Copy the entire `anno-companion-telemetry-probe` folder into the Anno 117 `mods` directory. Confirm that the installed manifest is version `0.4.0` and keep only one copy of this ModID enabled.

The final layout must be:

```text
mods/
└── anno-companion-telemetry-probe/
    ├── modinfo.json
    ├── README.md
    └── anno-companion/
        ├── scope-probe.lua
        └── telemetry-probe.lua  # retained broad probe; not loaded by this focused mod
```

Fully restart Anno 117 after updating the files.

## Test procedure

The probe takes one sample shortly after loading, then samples approximately every 10 seconds for up to 24 samples (about four minutes). It re-registers the event after each save load and also has an independent 12-second game-clock watchdog. Keep the game unpaused during each waiting period.

1. Load the same save used for the first probe.
2. On owned island A, open Production Statistics and select exactly that island. Leave it selected for at least 30 seconds.
3. Move to owned island B in the same region. Select only island B in Production Statistics and wait at least 30 seconds.
4. Switch to the other region. Select one owned island there in Production Statistics and wait at least 30 seconds.
5. On one tested island, use the normal UI to set a recognizable minimum stock or buy/sell offer for timber, tiles, or concrete. Wait for two more samples.
6. If time remains, close the statistics UI or clear its area selection and wait for two samples. This gives us a negative control.

The probe is complete when it emits `scope_probe_completed`. Reloading the save starts a fresh 24-sample test with a new `load_epoch`.

## Return the output

For the real-map test, search the game log for `scope_island_layout`. Capture one complete version `0.4.0` record while the camera is in Latium and one after moving to Albion. Also capture the matching `scope_runtime_capabilities` records. Together, these prove whether island rectangles and city Kontor coordinates share a usable world-coordinate system.

Also tell us which island was used in each step and which passive-trade setting you changed. That manual UI evidence is needed to determine whether the statistics and workforce globals follow the current camera area, the statistics UI selection, or another hidden context.

## Expected limitations

- Direct `io.open` output is not attempted; the first probe proved that `io` is unavailable.
- Factories, ships, population details, and full finance categories are intentionally omitted from this test.
- History may remain empty until the Production Statistics UI has an active area selection.
- Localized names are diagnostic labels only. Stable identifiers in the eventual data model will use numeric GUIDs/IDs.
