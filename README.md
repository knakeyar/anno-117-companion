# Anno Companion v1.1

Anno Companion is a local, read-only economic workspace for Anno 117. It turns JSON records emitted to the game log into durable campaign state, interactive regional maps, ranked actions and trade plans, city-specific production pressure, finance guidance, workforce facts, and an optional on-demand advisor.

> Manage your empire the way Caesar definitely did: with fancy dashboards and up-to-date information about trade and resource production. Better yet, Caesar's greatest achievements were apparently powered by AI workers—although at the time he used the word “slaves.” Please do not quote us on these completely made-up historical facts. Connect your game data to AI for suggestions on keeping your people happy. Note: this only works for Anno, not real life.

## Why Anno Companion?

If you're anything like me, finding a meaningful block of uninterrupted time for Anno 117 is difficult—and let's be honest, two hours is barely enough to remember why you opened the trade-route screen. By the time I return to a campaign, I often no longer remember which shortage I was fixing, what needed to move between cities, or what I planned to build next.

Anno Companion is designed for that stop-and-start way of playing. It preserves the last known state of your empire—along with your trade plans, resource pressures, and economic priorities—so you can end a session and return later without losing the thread. Instead of reconstructing yesterday's plans, you can see where you left off and decide what to do next.

## What runs

- `anno-companion-data` polls the mounted game-log directory, creates `/data/anno-companion.sqlite3`, normalizes only complete production snapshots, owns persistent campaign state, calculates deterministic management signals, and serves the private API. The optional OpenAI call also runs here so the API key never enters the browser image.
- `anno-companion-dashboard` serves the React application on `http://127.0.0.1:8080` and proxies API/SSE traffic over the internal Compose network.
- `mod/anno-companion-telemetry` is the production game mod. The research probe remains separate and is not required at runtime.

The dashboard never mounts or opens SQLite directly. Mount a directory for `/data`, not an individual database file, because SQLite also maintains WAL and shared-memory files.

## Windows setup

1. Copy the entire [`mod/anno-companion-telemetry`](mod/anno-companion-telemetry) folder into the Anno 117 **Documents** mods directory. Confirm its manifest is version `1.1.1`. Disable the telemetry probe during ordinary use. Version 1.1.1 adds the ship-backed active-route list.
2. Copy `.env.example` to `.env` and replace `YOUR_WINDOWS_USER`. `ANNO_LOG_DIR` must be the directory containing the game log where `ANNO_COMPANION_TELEMETRY_JSON` appears.
3. Create the `ANNO_DATA_DIR` directory if it does not exist.
4. From PowerShell in this repository, run:

   ```powershell
   docker compose up --build -d
   docker compose ps
   ```

5. Open [http://127.0.0.1:8080](http://127.0.0.1:8080). The Health page shows the mounted log cursor, database path/size, current play-session epoch, parse errors, and catalog coverage.

To stop without deleting data:

```powershell
docker compose down
```

The SQLite database remains in `ANNO_DATA_DIR`. Do not use `docker compose down -v` as a cleanup shortcut when changing to a named-volume configuration later.

Campaigns start with an automatically generated “Unassigned” name. Settings can rename the current campaign or move the current play session to another campaign when the game seed/participant evidence belongs to an existing save.

Cities, current inventory, finance, last-observed workforce, map placement, actions, conversations, and companion route plans are stored in SQLite. Leaving the game or stopping telemetry makes these values stale/inactive; it does not hide or reset them. The Areas screen supports manual Latium/Albion placement when a runtime coordinate binding is unavailable.

## Optional advisor

Set `OPENAI_API_KEY` in `.env` to enable the Ask advisor drawer. The model, reasoning effort, and timeout are configurable; the default is `gpt-5.6-luna` with low reasoning effort. No AI request runs during ingestion or ordinary dashboard use. Each submitted question sends only a compact selected-campaign summary, deterministic action evidence, catalog coverage, and up to 12 local conversation messages. Raw logs and the database are never sent, hosted tools are not enabled, and Responses are requested with `store=false`.

If the key is missing or the request fails, deterministic actions continue to work and the dashboard shows a non-blocking advisor error. `store=false` avoids Responses application-state storage, but normal API abuse-monitoring retention can still apply under the OpenAI account's data controls.

## Data contract

Telemetry schema v2 emits a full baseline after load, change-only snapshots every 30 seconds of advancing game time, and a complete reconciliation every 10 game minutes. Product and building records are chunked to bound log-line size. The data service promotes state only when every required chunk and completion record agrees; read failures preserve the previous value and mark that section stale rather than writing zero.

Important scope rules are visible in both the API and dashboard:

- inventory is all-controlled-area scope;
- treasury is participant scope;
- workforce is current-camera-area scope;
- UI-selected production statistics/history are raw-only and are not assigned to islands;
- engine trend and free-space values remain raw diagnostics;
- route proposals are companion plans and do not imply route feasibility or an existing in-game route;
- production pressure is inferred from stock history unless a verified static recipe relationship exists.

The pinned community catalog release contains 145 reference products, 113 inventory-enabled factory goods, and 144 factory recipes. It records source revision and attribution but does not bundle proprietary icon binaries. See [`docs/data-model-v1.md`](docs/data-model-v1.md), [`catalog/anno117-community-2.1-c6a6e752.json`](catalog/anno117-community-2.1-c6a6e752.json), and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Runtime capability check

Coordinates and per-city factory counts depend on game Lua bindings that cannot be verified outside Anno. Before treating them as proven on your installation, temporarily enable [`mod/anno-companion-telemetry-probe`](mod/anno-companion-telemetry-probe), capture one `scope_runtime_capabilities` record in Latium and one in Albion, then disable the probe again. Failed coordinate reads use manual map placement; failed building reads remain `presence unknown` and production remains stock-derived.

## Development and verification

Backend:

```bash
python3 -m venv .venv
.venv/bin/pip install -e 'services/data[test]'
.venv/bin/pytest -q services/data/tests
```

Dashboard:

```bash
cd apps/dashboard
npm ci
npm run check:api
npm test
npm run build
npm run test:e2e
```

Run `npm run generate:api` after changing the FastAPI contract. It exports OpenAPI and regenerates the typed dashboard client; `check:api` fails when either generated artifact is stale.

Catalog consistency:

```bash
python3 tools/generate_catalog.py --check
```

Compose defaults to ignored local `runtime-data` directories when `.env` is absent, which is useful for Linux development. Because the data image runs as UID 10001, make that local bind directory writable before the first Linux smoke test, for example with `sudo chown -R 10001:10001 runtime-data/data`. Docker Desktop users should configure the absolute Windows paths in `.env`.
