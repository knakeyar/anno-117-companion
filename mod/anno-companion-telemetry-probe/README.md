# Anno Companion Focused Route Probe 0.5.0

This temporary, read-only probe tests the remaining runtime surfaces needed by the interactive trade network. It never creates, edits, pauses, or deletes an Anno route.

Every sample emits `ANNO_COMPANION_PROBE_JSON` records. Search the game log for the `scope_route_capabilities` event.

## What it tests

- `TradeRoute.UIEditRoute` while a route is open, including its name and coarse issue state.
- Every route-capable ship visible in the loaded session: ID, player-visible name, assigned route name, pause state, session, area, and `Position2D`.
- The declared `CGameObject.ItemContainer.Cargo` surface as a possible alternative cargo source.
- Whether any bounded, declared station or configured-good identifiers become available from the open route.

The prior `CGameObject.Logistic` cargo path is deliberately **not** retried because it returned invalid weak references for every tested ship. `ItemContainer.Cargo` remains an unvalidated diagnostic even when it returns values: it may describe equipped items rather than product cargo.

The generated declarations expose `GetStation(stationID)` and `GetGood(goodID)`, but no station-ID or good-ID collection. The probe records configured goods as `not_attempted` unless real identifiers are exposed; it never guesses or brute-forces IDs.

## Install/update

Copy the entire `anno-companion-telemetry-probe` folder into the Anno 117 `mods` directory. Confirm that the installed `modinfo.json` says version `0.5.0`, keep only one copy of this ModID enabled, and fully restart Anno.

```text
mods/
└── anno-companion-telemetry-probe/
    ├── modinfo.json
    ├── README.md
    └── anno-companion/
        ├── scope-probe.lua
        └── telemetry-probe.lua  # retained reference module; not loaded
```

## Test procedure

Prepare three ordinary routes whose names contain easily recognized companion tags:

1. one route entirely inside Latium;
2. one route entirely inside Albion;
3. one route that travels between Latium and Albion.

Assign at least one named ship to each route. Then:

1. Load the save and leave the game unpaused.
2. In Latium, open the intra-Latium route editor and leave it open for at least 20 seconds.
3. Switch to Albion, open the intra-Albion route editor, and wait at least 20 seconds.
4. Open the cross-region route editor and wait at least 20 seconds in each region it visits.
5. If practical, pause one assigned ship for one sample and then resume it. This validates the runtime-state rules without changing route identity.

The probe samples about every 10 advancing game seconds for up to 36 samples. Reloading the save starts a new `load_epoch`.

## Return the output

Send the complete log lines containing `scope_route_capabilities` for all three route tests. Note which route and region were open for each sample.

Fields remain diagnostic until the logs prove their semantics. Route tags, route names, assigned ship IDs/names, pause state, and route issues are already sufficient for automatic companion-plan detection; configured goods and cargo remain unavailable until separately validated.
