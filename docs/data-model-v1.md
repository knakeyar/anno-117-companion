# Anno Companion v1 data model

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
| `area_product_observation` | Per-area/product stock, availability, product capacity, reservation, raw engine diagnostics, passive minimum, and raw offer booleans. |
| `area_population_observation` | Per-area population-tier counts; fractional values are retained. |
| `participant_finance_observation` | One participant treasury/balance record per snapshot. |
| `finance_category_observation` | Localized ordinal categories; zero GUIDs are retained as raw evidence, not identity. |
| `area_workforce_observation` | Current-camera-area scope only; precise registered production/consumption and delta fields. |
| `trade_route_issue_observation` | Ephemeral route-name label and coarse issue code; no durable route entity. |

UI-selected production statistics/history, ship cargo, route topology, periodic factory records, and the invalid `buffed_delta` candidate have no normalized v1 tables.

## Deterministic management layer

The API calculates rather than persists:

- median interval net-stock velocity over the last five game minutes, with at least three valid intervals and no gap over two telemetry cadences;
- play-session-local velocity segments that ignore paused duplicate clocks and restart after a clock rollback;
- low and high targets using explicit policy, then passive minimum for low, then 25%/80% capacity defaults;
- low, near-full, falling, and estimated-stockout-within-30-game-minutes pressure;
- source/destination transfer candidates bounded by both islands’ targets;
- static-recipe input pressure and output congestion.

These outputs always carry snapshot, play-session, observation time, scope, freshness, and catalog coverage. They use “net stock change” and “inferred pressure”; they are not presented as measured factory production or consumption.
