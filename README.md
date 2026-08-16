# Anno Companion v1.2

Manage your empire the way Caesar definitely did: with fancy dashboards and up-to-date information about trade and resource production. Better yet, Caesar's greatest achievements were apparently powered by AI workers—although at the time he used the word “slaves.” Please do not quote us on these completely made-up historical facts. Connect your game data to AI for suggestions on keeping your people happy. Note: this only works for Anno, not real life.

> Anno Companion is a local, read-only economic workspace for Anno 117. It turns JSON records emitted to the game log into durable campaign state, interactive regional trade networks, ranked actions and tagged route plans, city-specific production pressure, finance guidance, workforce facts, and an optional on-demand advisor.

## Why Anno Companion?

If you're anything like me, finding a meaningful block of uninterrupted time for Anno 117 is difficult—and let's be honest, two hours is barely enough to remember why you opened the trade-route screen. By the time I return to a campaign, I often no longer remember which shortage I was fixing, what needed to move between cities, or what I planned to build next.

Anno Companion is designed for that stop-and-start way of playing. It preserves the last known state of your empire—along with your trade plans, resource pressures, and economic priorities—so you can end a session and return later without losing the thread. Instead of reconstructing yesterday's plans, you can see where you left off and decide what to do next.

## What runs

- `anno-companion-data` polls the mounted game-log directory, creates `/data/anno-companion.sqlite3`, normalizes only complete production snapshots, owns persistent campaign state, calculates deterministic management signals, and serves the private API. The optional OpenAI call also runs here so the API key never enters the browser image.
- `anno-companion-dashboard` serves the React application on `http://127.0.0.1:8080` and proxies API/SSE traffic over the internal Compose network.
- `mod/anno-companion-telemetry` is the production game mod. The research probe remains separate and is not required at runtime.

The dashboard never mounts or opens SQLite directly. Mount a directory for `/data`, not an individual database file, because SQLite also maintains WAL and shared-memory files.

## Windows setup

### Prerequisites

Anno Companion uses Linux containers through Docker Desktop's WSL 2 backend. You do not need to run the companion from a Linux terminal; after WSL and Docker Desktop are installed, the commands below can be run from PowerShell.

1. Confirm that hardware virtualization is enabled in BIOS/UEFI and that your Windows version meets Docker's requirements.
2. Open **PowerShell as Administrator**, install WSL, and restart Windows when prompted:

   ```powershell
   wsl --install
   ```

3. After restarting, update WSL and confirm that the installed distribution uses version 2:

   ```powershell
   wsl --update
   wsl --version
   wsl --list --verbose
   ```

   New installations use WSL 2 by default. If an existing distribution reports version 1, follow Microsoft's upgrade instructions. See the official [Microsoft WSL installation guide](https://learn.microsoft.com/windows/wsl/install).

4. Download and install [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/). During installation, select the WSL 2 backend. Start Docker Desktop and wait until it reports that the engine is running.
5. In Docker Desktop, confirm **Settings → General → Use the WSL 2 based engine** is enabled and that Docker is using Linux containers.
6. Verify the installation from PowerShell:

   ```powershell
   docker version
   docker compose version
   ```

   If a command mentions `dockerDesktopLinuxEngine` or a missing named pipe, Docker Desktop is not running yet or its WSL 2 engine has not finished starting.

### Install Anno Companion

1. Download the repository as a ZIP from GitHub, or clone it and enter the repository directory:

   ```powershell
   git clone https://github.com/knakeyar/anno-117-companion.git
   cd anno-117-companion
   ```

2. Copy the entire [`mod/anno-companion-telemetry`](mod/anno-companion-telemetry) folder into one of the Anno 117 mod directories:

   - `C:\Users\YOUR_WINDOWS_USER\Documents\Anno 117 - Pax Romana\mods`
   - `C:\Program Files (x86)\Steam\steamapps\common\Anno 117 - Pax Romana\mods`

   Confirm its manifest is version `1.1.2`. Disable the telemetry probe during ordinary use. Version 1.1.2 adds player-visible ship names and fixes runtime city-coordinate capture.
3. Copy `.env.example` to `.env` and replace `YOUR_WINDOWS_USER`. The default `ANNO_LOG_DIR` points to `C:/Users/YOUR_WINDOWS_USER/Documents/Anno 117 - Pax Romana/log`, which must contain the game log where `ANNO_COMPANION_TELEMETRY_JSON` appears. Keep forward slashes in `.env` paths.
4. Create the directory configured by `ANNO_DATA_DIR`. The default is `C:/Users/YOUR_WINDOWS_USER/Documents/Anno Companion/data`; any writable persistent directory is acceptable.
5. Start Docker Desktop. Then, from PowerShell in the repository directory, run:

   ```powershell
   docker compose up --build -d
   docker compose ps
   ```

6. Wait for both services to report `healthy`, then open [http://127.0.0.1:8080](http://127.0.0.1:8080). The Health page shows the mounted log cursor, database path/size, current play-session epoch, parse errors, and catalog coverage.

To stop without deleting data:

```powershell
docker compose down
```

The SQLite database remains in `ANNO_DATA_DIR`. Do not use `docker compose down -v` as a cleanup shortcut when changing to a named-volume configuration later.

Campaigns start with an automatically generated “Unassigned” name. Settings can rename the current campaign or move the current play session to another campaign when the game seed/participant evidence belongs to an existing save.

Cities, current inventory, finance, last-observed workforce, actions, conversations, route links, and companion route plans are stored in SQLite. Leaving the game or stopping telemetry makes these values historical; it does not hide, reset, or mark a previously running route inactive. Areas is a collapsible region-and-city navigator; Trade provides the large Latium, Albion, and cross-region relationship graphs.

### Using the trade network

1. Save a recommended route as either a one-time emergency transfer or recurring supply plan.
2. Copy its short generated route name, such as `AC-7K2P Aga-Tit`, into the route name in Anno and assign a ship.
3. After the next complete telemetry cadence, the exact tag links the observed route to the plan. Running, partially paused, paused, issue, and freshness state remain separate from the plan workflow.
4. Click a directed graph edge to see every underlying plan, observed route, named ship, warning, and goods-evidence category. Quantities are target movements, not verified per-trip settings.
5. Existing routes following `Good SRC - DST`, such as `Bread Cud - Rhy`, auto-link when both three-letter city aliases are unique. Ambiguous and default route names remain in the collapsed attention tray, where they can be associated with a saved companion plan.

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
- a saved plan receives an exact `AC-XXXXX` tag; it becomes implemented/running only when telemetry observes that tag in an Anno route name with assigned ship evidence;
- existing routes following `Good SRC - DST` auto-link only when both three-letter city aliases resolve uniquely in the selected campaign;
- goods read from route names are label evidence only, never verified route configuration or onboard cargo;
- ambiguous and default route names stay in the attention tray; its manual fallback associates an observed route with a saved companion plan rather than guessing arbitrary endpoints;
- planned goods, configured route goods, and cargo aboard are separate evidence kinds and are never conflated;
- production pressure is inferred from stock history unless a verified static recipe relationship exists.

The pinned community catalog release contains 145 reference products, 113 inventory-enabled factory goods, and 144 factory recipes. It records source revision and attribution but does not bundle proprietary icon binaries. See [`docs/data-model-v1.md`](docs/data-model-v1.md) and [`catalog/anno117-community-2.1-c6a6e752.json`](catalog/anno117-community-2.1-c6a6e752.json).

## Credits and catalog provenance

Anno Companion's product and production-chain coverage would not exist in its current form without the excellent community work in [`anno-mods/anno-117-calculator`](https://github.com/anno-mods/anno-117-calculator). Specific thanks go to its author and maintainer **Nico Höllerich (NiHoel)** and to everyone who has contributed data, code, testing, and feedback to that project.

This repository imports structured catalog data from the calculator at the deliberately pinned revision [`c6a6e752`](https://github.com/anno-mods/anno-117-calculator/tree/c6a6e7525d16927f74d4f554dde5831b84fa287c). We use that data to:

- identify 145 reference products and the 113 factory input/output goods queried by the telemetry mod;
- model 144 factories and their recipe inputs, outputs, cycle times, regions, DLC markers, base maintenance, and workforce requirements;
- generate the Lua product/building allowlists used by the production telemetry mod; and
- provide catalog labels, coverage reporting, production-chain relationships, estimated base maintenance, workforce grouping, inferred pressure, and trade-planning context in the data service and dashboard.

The upstream calculator is MIT-licensed. Its application is not embedded here, and Anno Companion does not redistribute its proprietary game-icon assets. The exact source files, transformation path, license notice, and Ubisoft asset boundary are documented in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Optional route capability check

The trade network already works from companion plans, exact route-name tags, the explicit three-letter city naming convention, assigned ship IDs/names, pause state, and route issues. Configured route goods, ship cargo, and live ship positions remain unverified capabilities and are never guessed.

Probe version `0.5.0` is a temporary focused test for those fields. Copy [`mod/anno-companion-telemetry-probe`](mod/anno-companion-telemetry-probe) into the Anno mods directory, follow its three-route Latium/Albion/cross-region procedure, return the `scope_route_capabilities` log records, and then disable it. The probe does not modify routes and deliberately does not retry the previously invalid `Logistic` cargo reference.

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

## License

Anno Companion's original code and documentation are source-available under the [PolyForm Noncommercial License 1.0.0](LICENSE). You may use, study, modify, fork, and redistribute the project for noncommercial purposes. You may not sell it, charge for access to it, include it in a paid product or service, or otherwise use it for commercial purposes without separate permission from the copyright holders.

Because of that noncommercial restriction, this is not an OSI-approved open-source license. Third-party components and derived materials remain under their respective terms; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
