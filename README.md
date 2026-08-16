# Anno Companion v1

Anno Companion is a local, read-only operations dashboard for Anno 117. It turns JSON records emitted to the game log into durable inventory history, trade planning, production-chain pressure, finance, workforce, and route-health views.

## What runs

- `anno-companion-data` polls the mounted game-log directory, creates `/data/anno-companion.sqlite3`, normalizes only complete production snapshots, calculates deterministic management signals, and serves the private API.
- `anno-companion-dashboard` serves the React application on `http://127.0.0.1:8080` and proxies API/SSE traffic over the internal Compose network.
- `mod/anno-companion-telemetry` is the production game mod. The research probe remains separate and is not required at runtime.

The dashboard never mounts or opens SQLite directly. Mount a directory for `/data`, not an individual database file, because SQLite also maintains WAL and shared-memory files.

## Windows setup

1. Copy the entire [`mod/anno-companion-telemetry`](mod/anno-companion-telemetry) folder into the Anno 117 **Documents** mods directory. Disable the telemetry probe while using the production mod.
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

## Data contract

The production mod emits a lifecycle event, snapshot start, participant record, one bounded record per controlled area, and snapshot completion every 30 seconds of advancing game time. The data service promotes a snapshot to current state only when its completion record and expected area count agree.

Important scope rules are visible in both the API and dashboard:

- inventory is all-controlled-area scope;
- treasury is participant scope;
- workforce is current-camera-area scope;
- UI-selected production statistics/history are raw-only and are not assigned to islands;
- engine trend and free-space values remain raw diagnostics;
- transfer candidates do not imply a feasible route;
- production pressure is inferred from stock history unless a verified static recipe relationship exists.

See [`docs/data-model-v1.md`](docs/data-model-v1.md) for the schema and [`catalog/starter-catalog.json`](catalog/starter-catalog.json) for current reference-data coverage.

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
