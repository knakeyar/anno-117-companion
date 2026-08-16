# Anno Companion Telemetry Probe 0.1.1

This is a read-only diagnostic mod. It does not change game state. It runs the first-pass runtime probes together, catches each probe failure independently, and emits one-line JSON records prefixed with:

```text
ANNO_COMPANION_PROBE_JSON 
```

## Install

Copy the entire `anno-companion-telemetry-probe` folder into either supported Anno 117 mods directory:

```text
<user documents>/Anno 117 - Pax Romana/mods/
```

or:

```text
<Anno 117 installation>/mods/
```

The result must be:

```text
mods/
└── anno-companion-telemetry-probe/
    ├── modinfo.json
    ├── README.md
    └── anno-companion/
        └── telemetry-probe.lua
```

Start Anno 117 and load a save. The probe waits 30 meta-game ticks after the loader's `Load` callback, then runs once.

## Find the output

First check that the mod loaded in:

```text
<user documents>/Anno 117 - Pax Romana/mods/mod-loader.log
```

Search the game's log files for `ANNO_COMPANION_PROBE_JSON`. The normal game log is commonly under the Anno 117 documents `log/` directory. The probe also attempts to append the same records to this game-relative path:

```text
logs/anno-companion-probe.jsonl
```

Direct file output is itself one of the experiments. If the Lua sandbox rejects `io.open`, the failure is caught and emitted to the normal game log as `file_output_error`.

PowerShell search example:

```powershell
Get-ChildItem "$env:USERPROFILE\Documents\Anno 117 - Pax Romana" -Recurse -File |
  Select-String "ANNO_COMPANION_PROBE_JSON"
```

The useful records begin with `probe_run_started` and end with `probe_run_finished`. Please preserve every line between them, including records where `ok` is `false`.

## Disable probes and retry one by one

Open `anno-companion/telemetry-probe.lua` and find the `CONFIG.probes` block near the top. Set every probe to `false`, then enable one at a time:

```lua
probes = {
    transport = true,
    context = false,
    products = false,
    areas = false,
    storage = false,
    population = false,
    workforce = false,
    passive_trade = false,
    statistics = false,
    history = false,
    finance = false,
    trade_routes = false,
    ships = false,
    factories = false,
}
```

Recommended isolation order:

1. `transport`
2. `context`
3. `products`
4. `areas`
5. `storage`
6. `population`
7. `workforce`
8. `passive_trade`
9. `statistics`
10. `history`
11. `finance`
12. `trade_routes`
13. `ships`
14. `factories`

Restart the game after editing the mod. Lua script support is experimental and hot reload is not assumed.

## Safe limits

The telemetry probes use only four initial product GUIDs, while the product-metadata probe adds one deliberately invalid control value. Issue routes, ships, factories, population levels, workforce types, and finance categories are capped. These limits are in `CONFIG` and prevent a mature save from generating excessive output.

The product GUIDs are taken from the extracted game's `specialguids.lua`:

- `2174` — Roman timber
- `2176` — tiles
- `2178` — Roman concrete
- `1010017` — money (included to test product classification/meta storage)
- `-1` — deliberately invalid control value (used only by the product metadata probe)

Invalid or region-inapplicable products are expected to produce useful error/null evidence rather than being treated as zero.
