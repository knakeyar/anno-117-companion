# Anno Companion v1.2 data model

The SQLite database is an observation store, not a reconstruction of hidden game state. String identifiers prevent cross-language precision loss, quantities are `REAL`, timestamps are UTC receipt times, and every time-series derivative stays inside one backend-created play-session authority epoch.

## Reference and identity

| Table | Role |
|---|---|
| `static_release` | Immutable catalog release and source hash. |
| `product` | Versioned product identity and telemetry allowlist. |
| `building_type` | Versioned building metadata. |
| `production_recipe` / `production_recipe_item` | Versioned cycle and input/output relationships. |
| `campaign` | User-visible grouping with provisional seed/participant identity evidence. |
| `play_session` | One mod load and authoritative timeline epoch. |
| `area` | Campaign-scoped area identity; `(campaign_id, area_id_raw)` is unique. |
| `area_product_policy` | Mutable companion-only targets, priority, and transfer exclusion. |
| `building_maintenance_item` | Versioned base maintenance/workforce costs from the pinned catalog. |
| `companion_setting` | Persistent selected-campaign context. |

An area receives a region/session label only when it is also the valid current camera area in that snapshot. The global controlled-area enumeration is not incorrectly stamped with the camera’s region.

## Raw transport and completeness

| Table | Role |
|---|---|
| `ingestion_cursor` | Per-file fingerprint, byte offset, size, and error for rotation-safe polling. |
| `telemetry_raw` | Immutable source JSON, hash, source offset, parsing and normalization outcome. |
| `snapshot_batch` | Batch context and authoritative `is_complete` decision. |
| `snapshot_section_status` | Success, failure, not-observed, count, truncation, and errors per section/scope. |

Only a complete production snapshot can become current. Legacy focused-probe records may populate area identity and raw evidence, but remain `legacy_partial` because they sampled inventory for only one target area.

## Observed facts

| Table | Scope and notes |
|---|---|
| `area_snapshot` | Per-area descriptive, population-summary, area-balance, and land-tax facts. |
| `area_product_observation` / `area_product_current` | Sparse history plus materialized current per-area/product state. |
| `area_building_observation` / `area_building_current` | Sparse building-count history and current presence; successful zero is not installed, failed reads are unknown. |
| `area_location` | Observed Kontor coordinates/session plus companion-only manual schematic override. |
| `area_population_observation` | Per-area population-tier counts; fractional values are retained. |
| `participant_finance_observation` | One participant treasury/balance record per snapshot. |
| `finance_category_observation` | Localized ordinal categories; zero GUIDs are retained as raw evidence, not identity. |
| `area_workforce_observation` | Current-camera-area scope only; precise registered production/consumption and delta fields. |
| `trade_route_issue_observation` | Ephemeral route-name label and coarse issue code; not a durable route identity. |
| `active_trade_route_current` / `active_trade_route_ship_current` | Last complete ship-backed route-name evidence. Route names remain mutable labels and ship IDs remain the stronger rename clue. |

UI-selected production statistics/history, periodic factory records, and the invalid `buffed_delta` candidate have no normalized v1 tables. Route endpoints may be linked from exact `Good SRC - DST` names only when both three-letter aliases resolve uniquely inside the campaign; this is stored as `route_name` evidence and is never fuzzy-matched. The optional route-good observation table remains empty until configured goods or cargo are independently validated; product labels parsed from route names are presentation evidence only, while failed or speculative probes are raw-only.

Materialized state changes only after a complete baseline, delta, or reconciliation. A failed read updates freshness/error evidence without replacing the previous value. A telemetry unload ends the active play session but never clears selected campaign state.

## Persistent workflows

| Table | Role |
|---|---|
| `management_action` | Stable deterministic action identity and active/accepted/snoozed/dismissed/completed/resolved workflow. |
| `trade_plan` / `trade_plan_item` | Companion-only route intent; item amounts are total tons for one-time plans or tons/minute for recurring plans. Cargo slots, round-trip time, and ship cost are user assumptions; no write is made to Anno. |
| `trade_route_link` | Exact-tag, exact unique route-name convention, or user-confirmed evidence connecting an opaque observed Anno route to source/destination cities and, optionally, a companion plan. |
| `trade_route_good_observation` | Optional future normalized evidence for configured route goods or cargo aboard. Evidence kind is mandatory; planned intent is never written here. |
| `advisor_conversation` / `advisor_message` | Campaign-scoped local conversation history and validated action references. |

## Deterministic management layer

The API calculates rather than persists:

- median interval net-stock velocity over the last five game minutes, with at least three valid intervals and no gap over two telemetry cadences;
- play-session-local velocity segments that ignore paused duplicate clocks and restart after a clock rollback;
- low and high targets using explicit policy, then passive minimum for low, then 25%/80% capacity defaults;
- low, near-full, falling, and estimated-stockout-within-30-game-minutes pressure;
- source/destination transfer candidates bounded by both islands’ targets;
- static-recipe input pressure and output congestion.
- reported-balance versus treasury-trend analysis and category evidence;
- inferred base maintenance from observed factory counts, explicitly excluding buffs;
- grouped, bounded source/destination route proposals with unknown feasibility.
- campaign-scoped Latium, Albion, and cross-region graph edges aggregated by directed city pair without summing unlike goods;
- exact, case-insensitive `AC-XXXXX` route-tag matching with separate workflow, runtime, and freshness states.
- exact, unique three-letter city-alias resolution for observed `Good SRC - DST` route names; ambiguous names remain unmapped.

These outputs always carry snapshot, play-session, observation time, scope, freshness, and catalog coverage. They use “net stock change” and “inferred pressure”; they are not presented as measured factory production or consumption.
