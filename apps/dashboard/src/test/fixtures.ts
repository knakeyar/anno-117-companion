import type { InventoryResponse, OverviewResponse, StatusResponse, TradeResponse } from '../types'

export const meta = {
  snapshot_id: 44,
  play_session_id: 'play-1',
  observed_at: new Date(Date.now() - 12_000).toISOString(),
  scope: 'all_controlled_areas',
  freshness_seconds: 12,
  is_stale: false,
} as const

export const catalog = {
  release_id: 'anno117-v1-starter',
  label: 'Verified starter catalog',
  source_hash: 'abc',
  products: 3,
  recipes: 0,
  coverage: 'starter' as const,
  coverage_note: 'Verified construction products; recipe coverage is intentionally incomplete.',
}

export const inventory: InventoryResponse = {
  meta: { ...meta },
  catalog,
  items: [
    {
      area_pk: 1, area_id: '8513', area_name: 'Juliana', region_guid: '3225', product_guid: '2174', product_name: 'Timber', category: 'construction_material',
      stock: 92, available_stock: 92, capacity: 100, reserved: 0, fill_ratio: .92, free_space_raw: 8, engine_trend_raw: -1,
      passive_trade_minimum: 0, passive_trade_mode: 'sell', passive_trade_flags: {}, low_target: 25, high_target: 80,
      policy_source: 'capacity_default', priority: 0, excluded: false,
      velocity: { net_stock_change_per_minute: 4, interval_count: 5, window_minutes: 5, confidence: 'measured_history' }, estimated_stockout_minutes: null,
    },
    {
      area_pk: 2, area_id: '8961', area_name: 'Naissus', region_guid: '3225', product_guid: '2174', product_name: 'Timber', category: 'construction_material',
      stock: 8, available_stock: 8, capacity: 100, reserved: 0, fill_ratio: .08, free_space_raw: 92, engine_trend_raw: 0,
      passive_trade_minimum: 0, passive_trade_mode: 'none', passive_trade_flags: {}, low_target: 25, high_target: 80,
      policy_source: 'capacity_default', priority: 2, excluded: false,
      velocity: { net_stock_change_per_minute: -3.5, interval_count: 5, window_minutes: 5, confidence: 'measured_history' }, estimated_stockout_minutes: 2.3,
    },
  ],
  signals: [
    { code: 'low_stock', severity: 'critical', label: 'Stock is below the management target', area_pk: 2, area_name: 'Naissus', product_guid: '2174', product_name: 'Timber', priority: 2, evidence: { stock: 8, available_stock: 8, capacity: 100, low_target: 25, net_stock_change_per_minute: -3.5 }, interpretation: 'inferred_pressure' },
    { code: 'near_full', severity: 'warning', label: 'Storage is near capacity', area_pk: 1, area_name: 'Juliana', product_guid: '2174', product_name: 'Timber', priority: 0, evidence: { stock: 92, available_stock: 92, capacity: 100, low_target: 25, net_stock_change_per_minute: 4 }, interpretation: 'inferred_pressure' },
  ],
}

export const trade: TradeResponse = {
  meta: { ...meta },
  items: [{ product_guid: '2174', product_name: 'Timber', source_area_pk: 1, source_area_name: 'Juliana', destination_area_pk: 2, destination_area_name: 'Naissus', advisory_amount: 12, destination_priority: 2, route_feasibility: 'unknown', interpretation: 'transfer_candidate' }],
  notice: 'Advisory transfer candidates; route feasibility is unknown.',
}

export const overview: OverviewResponse = {
  meta: { ...meta }, catalog,
  finance: { participant_guid: '41', treasury: 3_756_154, total_balance_raw: 200, trade_balance_period_raw: 50, passive_trade_balance_period_raw: 20, active_trade_balance_period_raw: 30, categories: [] },
  signals: inventory.signals,
  transfer_candidates: trade.items,
  route_issues: [{ route_name: 'Supply route', issue_code: 'no_ships', severity: 'critical', active_error_count: 1, identity_scope: 'ephemeral_route_name' }],
  workforce_shortages: [{ area_pk: 1, area_name: 'Juliana', scope: 'current_camera_area', workforce_guid: '2181', name: 'Libertus Workforce', population_count: 100, resulting_from_population: 50, registered_production: 55, registered_consumption: -60, delta_without_buffs: -5, delta_with_buffs: -5 }],
  counts: { inventory_items: 2, signals: 2, transfer_candidates: 1 },
  language: { rate_label: 'Net stock change', pressure_label: 'Inferred pressure' },
}

export const status: StatusResponse = {
  service: 'anno-companion-data', status: 'ok',
  database: { path: '/data/anno-companion.sqlite3', exists: true, size_bytes: 131072, journal_mode: 'WAL' },
  telemetry: { directory: '/telemetry', glob: '*.log', parse_error_count: 0, sources: [{ path: '/telemetry/game.log', fingerprint: '1:2', byte_offset: 1000, file_size: 1000, last_read_at: new Date().toISOString(), last_error: null }] },
  play_session: { play_session_id: 'play-1', campaign_id: 'campaign-1', load_epoch: 1, mod_version: '1.0.0', game_seed: '951', started_at: new Date().toISOString() },
  latest_snapshot: { ...meta }, catalog,
}

export const apiFixtures: Record<string, unknown> = {
  '/api/v1/status': status,
  '/api/v1/campaigns': [{ campaign_id: 'campaign-1', display_name: 'Marcia’s campaign', game_seed: '951', participant_guid: '41', identity_method: 'game_seed_participant', identity_confidence: 'user_confirmed', created_at: new Date().toISOString(), archived_at: null }],
  '/api/v1/areas': { campaign_id: 'campaign-1', items: [{ area_pk: 1, area_id: '8513', name: 'Juliana', region_guid: '3225', game_session_guid: '3245', region_evidence: 'current_camera_area_same_snapshot', first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }, { area_pk: 2, area_id: '8961', name: 'Naissus', region_guid: '3225', game_session_guid: '3245', region_evidence: 'current_camera_area_same_snapshot', first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }] },
  '/api/v1/inventory/latest': inventory,
  '/api/v1/dashboard/overview': overview,
  '/api/v1/trade/opportunities': trade,
  '/api/v1/production/chains': { meta, catalog, chains: [] },
  '/api/v1/finance': { meta, finance: overview.finance },
  '/api/v1/workforce': { meta, scope: 'current_camera_area', items: overview.workforce_shortages },
  '/api/v1/policies': { campaign_id: 'campaign-1', items: [] },
}

