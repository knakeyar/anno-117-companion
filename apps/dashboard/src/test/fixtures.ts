import type { ActiveTradeRoutesResponse, CityStockPlanningResponse, InventoryResponse, OverviewResponse, ProductionExplorerResponse, StatusResponse, TradeNetworkResponse, TradePlan, TradeResponse } from '../types'

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
  meta: { ...meta }, catalog,
  items: [{ product_guid: '2174', product_name: 'Timber', source_area_pk: 1, source_area_name: 'Juliana', destination_area_pk: 2, destination_area_name: 'Naissus', advisory_amount: 12, source_available_stock: 92, source_high_target: 80, projected_source_stock: 80, destination_available_stock: 8, destination_low_target: 25, projected_destination_stock: 20, destination_priority: 2, route_feasibility: 'unknown', interpretation: 'transfer_candidate' }],
  suggested_routes: [{ suggestion_id: 'route:1:2', action_id: 'act-route', source_area_pk: 1, source_area_name: 'Juliana', destination_area_pk: 2, destination_area_name: 'Naissus', goods: [{ product_guid: '2174', product_name: 'Timber', advisory_amount: 12, source_available_stock: 92, source_high_target: 80, projected_source_stock: 80, destination_available_stock: 8, destination_low_target: 25, projected_destination_stock: 20 }], confidence: 'high', reason: 'Observed destination deficit can be supplied from bounded source surplus.', evidence: { priority_score: 2 }, route_feasibility: 'unknown' }],
  notice: 'Advisory transfer candidates; route feasibility is unknown.',
}

export const activeTradeRoutes: ActiveTradeRoutesResponse = {
  meta: { ...meta },
  campaign_id: 'campaign-1',
  telemetry_status: 'success',
  scope: 'assigned_trade_route_ships_in_observed_game_session',
  identity_notice: 'Anno exposes a mutable route name but no stable route ID. Renamed or duplicate names may appear as separate or merged records.',
  capabilities: { assigned_ships: true, route_issues: true, stops: false, configured_goods: false, ship_cargo: false },
  counts: { ship_backed_routes: 1, issue_only_routes: 0, assigned_ships: 2 },
  items: [{
    route_key: 'route-olives', route_name: 'Olives Rav - Jul', identity_scope: 'mutable_route_name', evidence_kind: 'assigned_ships', status: 'partially_paused', is_active_last_observed: true,
    assigned_ship_count: 2, paused_ship_count: 1, regular_ship_count: 2, game_session_guid: '3245', region_guid: '3225', observed_at: meta.observed_at, freshness_seconds: 12, is_stale: false, issues: [],
    ships: [
      { ship_id: '8121', ship_name: 'Mercury', ship_guid: '37222', game_session_guid: '3245', area_id: '8513', is_paused: false, on_regular_route: true, loading_speed_factor: 1 },
      { ship_id: '8122', ship_name: null, ship_guid: '37223', game_session_guid: '3245', area_id: '8513', is_paused: true, on_regular_route: true, loading_speed_factor: 1.2 },
    ],
  }],
}

export const tradePlan: TradePlan = {
  trade_plan_id: 'plan-1', campaign_id: 'campaign-1', source_area_pk: 1, source_area_name: 'Juliana', destination_area_pk: 2, destination_area_name: 'Naissus',
  status: 'implemented', plan_kind: 'recurring_supply', route_tag: 'AC-7K2P', suggested_route_name: 'AC-7K2P Jul-Nai', usable_ship_capacity: null,
  expected_round_trip_minutes: null, estimated_required_ships: null, runtime_status: 'partially_paused', runtime_freshness: 'live', goods_verification: 'planned_only',
  last_runtime_match_at: meta.observed_at, reason: 'Keep Naissus supplied with Timber.', evidence: { source: 'deterministic_action' },
  goods: [{ product_guid: '2174', product_name: 'Timber', amount: 12 }], created_at: meta.observed_at, updated_at: meta.observed_at,
}

const networkNodes = [
  { node_id: 'area-1', area_pk: 1, area_name: 'Juliana', region: 'latium' as const, severity: 'warning' as const, pressure_count: 1, route_issue_count: 0, running_route_count: 0, paused_route_count: 1, planned_route_count: 0, stock_health: { tracked_goods: 1, average_fill_ratio: .92, critical: 0, warning: 1 }, important_goods: [{ product_guid: '2174', product_name: 'Timber', stock: 92, capacity: 100, fill_ratio: .92, net_stock_change_per_minute: 4 }], pressure_signals: [inventory.signals[1]] },
  { node_id: 'area-2', area_pk: 2, area_name: 'Naissus', region: 'latium' as const, severity: 'critical' as const, pressure_count: 1, route_issue_count: 0, running_route_count: 0, paused_route_count: 1, planned_route_count: 0, stock_health: { tracked_goods: 1, average_fill_ratio: .08, critical: 1, warning: 0 }, important_goods: [{ product_guid: '2174', product_name: 'Timber', stock: 8, capacity: 100, fill_ratio: .08, net_stock_change_per_minute: -3.5 }], pressure_signals: [inventory.signals[0]] },
  { node_id: 'area-3', area_pk: 3, area_name: 'Cudslip', region: 'albion' as const, severity: 'stable' as const, pressure_count: 0, route_issue_count: 0, running_route_count: 0, paused_route_count: 0, planned_route_count: 0, stock_health: { tracked_goods: 0, average_fill_ratio: null, critical: 0, warning: 0 }, important_goods: [], pressure_signals: [] },
]

const taggedRoute = {
  ...activeTradeRoutes.items[0],
  route_name: tradePlan.suggested_route_name,
}

const networkEdge = {
  edge_id: 'campaign-1:1:2', source_area_pk: 1, source_area_name: 'Juliana', destination_area_pk: 2, destination_area_name: 'Naissus', scope: 'latium' as const,
  status: 'partially_paused' as const, severity: 'critical' as const, freshness: 'live' as const, goods_verification: 'planned_only' as const,
  endpoint_evidence: [{ kind: 'route_tag', trade_plan_id: tradePlan.trade_plan_id }],
  plans: [{ trade_plan_id: tradePlan.trade_plan_id, plan_kind: tradePlan.plan_kind, workflow_status: tradePlan.status, runtime_status: tradePlan.runtime_status, runtime_freshness: tradePlan.runtime_freshness, route_tag: tradePlan.route_tag, suggested_route_name: tradePlan.suggested_route_name, reason: tradePlan.reason, goods: [{ ...tradePlan.goods[0], evidence_kind: 'planned' as const, trade_plan_id: tradePlan.trade_plan_id }] }],
  routes: [taggedRoute], ships: taggedRoute.ships, planned_goods: [{ ...tradePlan.goods[0], evidence_kind: 'planned' as const, trade_plan_id: tradePlan.trade_plan_id }],
  route_name_goods: [], configured_goods: [], cargo_aboard: [], issues: [], actions: [], summary: { goods: 1, routes: 1, ships: 2, plans: 1 },
}

export const tradeNetwork: TradeNetworkResponse = {
  meta: { ...meta }, catalog, campaign_id: 'campaign-1',
  graphs: {
    latium: { nodes: networkNodes.filter((node) => node.region === 'latium'), edges: [networkEdge] },
    albion: { nodes: networkNodes.filter((node) => node.region === 'albion'), edges: [] },
    cross_region: { nodes: networkNodes, edges: [] },
  },
  unmapped_routes: [{ ...activeTradeRoutes.items[0], route_key: 'route-bread', route_name: 'Bread Cud - Rhy', ships: [activeTradeRoutes.items[0].ships[0]], assigned_ship_count: 1, paused_ship_count: 0, status: 'running' }],
  capabilities: activeTradeRoutes.capabilities,
  evidence_notice: 'Endpoints require a companion plan, validated telemetry, or a confirmed manual link. Planned goods are not configured goods or cargo.',
}

export const stockPlanning: CityStockPlanningResponse = {
  meta: { ...meta },
  catalog,
  area: { area_pk: 1, area_name: 'Juliana', region_guid: '3225', population_total: 10_768, residence_count: 520 },
  groups: [{
    key: 'Roman:2181',
    label: 'Latium · Liberti',
    region_id: 'Roman',
    region_name: 'Latium',
    workforce_guid: '2181',
    population_guid: '1499',
    population_name: 'Liberti',
    population: 10_768,
    residence_count: 520,
    residence_count_source: 'telemetry',
    consumption_factor: 1.25,
    consumption_setting: 'Medium',
    consumption_setting_source: 'telemetry',
    status_counts: { deficit: 1, constrained: 0, healthy: 1, neutral: 0, unknown: 0 },
    items: [
      {
        product_guid: '2174', resource_name: 'Timber', icon: null, category: 'construction_material', natural_order: 1,
        stock: 8, capacity: 100, fill_ratio: .08, population_demand_per_minute: 0, production_input_demand_per_minute: 3.7,
        demand_per_minute: 3.7, per_1000: 0, supply_per_minute: 3.2, balance_per_minute: -.5,
        observed_net_stock_change_per_minute: -3.5, velocity_confidence: 'measured_history', velocity_is_historical: false,
        status: 'deficit', demand_sources: [{ recipe_id: 'factory:100', building_guid: '100', building_name: 'Sawmill consumer', building_count: 2, rate_per_minute: 3.7, evidence: 'catalog_cycle_and_observed_building_count' }],
        supply_sources: [{ recipe_id: 'factory:101', building_guid: '101', building_name: 'Lumberjack hut', building_count: 2, rate_per_minute: 3.2, evidence: 'catalog_cycle_and_observed_building_count' }], calculation_completeness: 'modeled_base',
      },
      {
        product_guid: '2175', resource_name: 'Bread', icon: null, category: 'food', natural_order: 2,
        stock: 735, capacity: 800, fill_ratio: .919, population_demand_per_minute: 2.2, production_input_demand_per_minute: 0,
        demand_per_minute: 2.2, per_1000: .204, supply_per_minute: 2.4, balance_per_minute: .2,
        observed_net_stock_change_per_minute: 0, velocity_confidence: 'stable', velocity_is_historical: false,
        status: 'healthy', demand_sources: [], supply_sources: [{ recipe_id: 'factory:102', building_guid: '102', building_name: 'Bakery', building_count: 2, rate_per_minute: 2.4, evidence: 'catalog_cycle_and_observed_building_count' }], calculation_completeness: 'modeled_base',
      },
    ],
  }],
  capabilities: { stock: true, observed_net_stock_change: true, population_demand: true, factory_base_capacity: true, construction_demand: false, active_project_demand: false, trade_flow_decomposition: false, runtime_modifiers: false },
  measurement_notice: 'Demand and supply are base planning estimates. Observed net stock change is shown separately.',
  planning_source: { source_url: 'https://github.com/anno-mods/anno-117-calculator', source_revision: 'c6a6e752', residence_counts: 'telemetry where available' },
}

export const productionExplorer: ProductionExplorerResponse = {
  meta: { ...meta },
  catalog: { ...catalog, recipes: 3 },
  area: { area_pk: 1, area_name: 'Juliana', region_guid: '3225', population_total: 10_768, residence_count: 520 },
  root_product_guid: '2175',
  resource_options: [
    { product_guid: '2175', name: 'Bread', icon: null, category: 'consumer_goods', required_rate: 2.2, has_local_recipe: true, stock: 735 },
    { product_guid: 'flour', name: 'Flour', icon: null, category: 'intermediate_goods', required_rate: null, has_local_recipe: true, stock: 300 },
    { product_guid: 'wheat', name: 'Wheat', icon: null, category: 'raw_materials', required_rate: null, has_local_recipe: true, stock: 180 },
  ],
  demand: { required_rate: 2.2, population: 2.2, production: 0, construction: null, other: null, completeness: 'modeled_base', sources: [] },
  resources: [
    { node_id: 'resource:2175', kind: 'resource', product_guid: '2175', name: 'Bread', icon: null, category: 'food', stock: 735, capacity: 800, stock_trend: 0, trend_confidence: 'stable', depth: 0, producer_factory_id: 'factory:bakery:2175', producer_state: 'selected', cycle_detected: false, required_rate: 2.2, status: 'healthy', alerts: [] },
    { node_id: 'resource:flour', kind: 'resource', product_guid: 'flour', name: 'Flour', icon: null, category: 'intermediate', stock: 300, capacity: 500, stock_trend: -0.2, trend_confidence: 'stable', depth: 2, producer_factory_id: 'factory:mill:flour', producer_state: 'selected', cycle_detected: false, required_rate: 2.2, status: 'deficit', alerts: [{ code: 'falling_stock', severity: 'warning', label: 'Net stock is falling' }] },
    { node_id: 'resource:wheat', kind: 'resource', product_guid: 'wheat', name: 'Wheat', icon: null, category: 'raw', stock: 180, capacity: 500, stock_trend: 0.3, trend_confidence: 'stable', depth: 4, producer_factory_id: 'factory:wheat:wheat', producer_state: 'selected', cycle_detected: false, required_rate: 2.2, status: 'healthy', alerts: [] },
  ],
  factories: [
    { node_id: 'factory:bakery:2175', kind: 'factory', recipe_id: 'factory:bakery', building_guid: 'bakery', building_name: 'Bakery', building_icon: null, workforce_guid: '2181', workforce_name: 'Libertus Workforce', cycle_seconds: 60, output_product_guid: '2175', output_amount: 2, output_per_minute_per_building: 2, installed_buildings: 2, presence_status: 'installed', base_maintenance: 25, depth: 1, alternatives: [{ recipe_id: 'factory:bakery', building_guid: 'bakery', building_name: 'Bakery', output_per_minute: 2, installed_buildings: 2, presence_status: 'installed', selected: true }], required_output_rate: 2.2, required_buildings: 1.1, buildings_needed: 2, available_output_rate: 4, capacity_balance_rate: 1.8, capacity_balance_buildings: .9, utilization: .55, status: 'healthy' },
    { node_id: 'factory:mill:flour', kind: 'factory', recipe_id: 'factory:mill', building_guid: 'mill', building_name: 'Mill', building_icon: null, workforce_guid: '2181', workforce_name: 'Libertus Workforce', cycle_seconds: 60, output_product_guid: 'flour', output_amount: 1, output_per_minute_per_building: 1, installed_buildings: 2, presence_status: 'installed', base_maintenance: 18, depth: 3, alternatives: [{ recipe_id: 'factory:mill', building_guid: 'mill', building_name: 'Mill', output_per_minute: 1, installed_buildings: 2, presence_status: 'installed', selected: true }], required_output_rate: 2.2, required_buildings: 2.2, buildings_needed: 3, available_output_rate: 2, capacity_balance_rate: -.2, capacity_balance_buildings: -.2, utilization: 1.1, status: 'deficit' },
    { node_id: 'factory:wheat:wheat', kind: 'factory', recipe_id: 'factory:wheat', building_guid: 'wheat-farm', building_name: 'Wheat Farm', building_icon: null, workforce_guid: '2181', workforce_name: 'Libertus Workforce', cycle_seconds: 60, output_product_guid: 'wheat', output_amount: 1, output_per_minute_per_building: 1, installed_buildings: 3, presence_status: 'installed', base_maintenance: 12, depth: 5, alternatives: [{ recipe_id: 'factory:wheat', building_guid: 'wheat-farm', building_name: 'Wheat Farm', output_per_minute: 1, installed_buildings: 3, presence_status: 'installed', selected: true }], required_output_rate: 2.2, required_buildings: 2.2, buildings_needed: 3, available_output_rate: 3, capacity_balance_rate: .8, capacity_balance_buildings: .8, utilization: .7333, status: 'healthy' },
  ],
  edges: [
    { edge_id: 'bread-bakery', source: 'resource:2175', target: 'factory:bakery:2175', kind: 'produced_by', recipe_amount: 2, required_rate: 2.2 },
    { edge_id: 'bakery-flour', source: 'factory:bakery:2175', target: 'resource:flour', kind: 'requires', recipe_amount: 2, required_rate: 2.2 },
    { edge_id: 'flour-mill', source: 'resource:flour', target: 'factory:mill:flour', kind: 'produced_by', recipe_amount: 1, required_rate: 2.2 },
    { edge_id: 'mill-wheat', source: 'factory:mill:flour', target: 'resource:wheat', kind: 'requires', recipe_amount: 1, required_rate: 2.2 },
    { edge_id: 'wheat-farm', source: 'resource:wheat', target: 'factory:wheat:wheat', kind: 'produced_by', recipe_amount: 1, required_rate: 2.2 },
  ],
  summary: { required_rate: 2.2, available_rate: 4, capacity_balance_rate: 1.8, required_buildings: 1.1, installed_buildings: 2, status: 'deficit', bottleneck_count: 2, bottlenecks: [{ node_id: 'factory:mill:flour', kind: 'factory', name: 'Mill', status: 'deficit' }, { node_id: 'resource:flour', kind: 'resource', name: 'Flour', status: 'deficit' }] },
  capabilities: { catalog_recipe_rates: true, observed_installed_buildings: true, observed_stock: true, observed_productivity_modifiers: false, construction_demand: false, active_project_demand: false },
  measurement_notice: 'Required throughput uses the City Stock Planning base demand model. Available rate is catalog base capacity from observed building counts; productivity buffs are not observed.',
}

export const overview: OverviewResponse = {
  meta: { ...meta }, catalog,
  finance: { participant_guid: '41', treasury: 3_756_154, total_balance_raw: 200, trade_balance_period_raw: 50, passive_trade_balance_period_raw: 20, active_trade_balance_period_raw: 30, categories: [] },
  balance_analysis: { reported_balance: 200, reported_balance_is_negative: false, treasury: 3_756_154, treasury_is_falling: false, treasury_change: 100, treasury_change_per_game_minute: 5, trade_balance: { total: 50, passive: 20, active: 30 }, category_totals: { gross_income: 300, gross_expenses: 100, net_profit: 200, interpretation: 'sum_of_observed_finance_categories' }, largest_positive_categories: [], largest_negative_categories: [], estimated_base_maintenance: { total: 12, cities: [{ area_pk: 1, area_name: 'Juliana', estimated_base_maintenance: 12, factories: [{ building_guid: '2955', building_name: 'Fishing Hut', count: 2, base_maintenance_each: 6, estimated_base_maintenance: 12 }] }], notice: 'Estimated base maintenance from catalog costs and observed factory counts; buffs and other modifiers are excluded.' }, guidance: [] },
  actions: [{ action_id: 'act-route', campaign_id: 'campaign-1', kind: 'transfer', severity: 'warning', title: 'Plan Juliana → Naissus', summary: 'Move Timber from observed surplus.', evidence: {}, deep_link: '/trade', status: 'active', snoozed_until: null, first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), resolved_at: null }],
  suggested_routes: trade.suggested_routes,
  signals: inventory.signals,
  transfer_candidates: trade.items,
  route_issues: [{ route_name: 'Supply route', issue_code: 'no_ships', engine_error_code: 12, label: 'Route has no ships', guidance: 'Assign an in-game ship to this route.', severity: 'critical', active_error_count: 1, identity_scope: 'ephemeral_route_name' }],
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
  selected_campaign_id: 'campaign-1', advisor: { configured: false, model: 'gpt-5.6-luna', reasoning_effort: 'low', on_demand_only: true },
}

const areaBase = { persistent: true, telemetry_active: true, position_source: 'manual' as const, location_status: 'success' as const, location_error: null, manual_placement: true, latest_observation: { observed_at: new Date().toISOString(), is_historical: false } }

export const apiFixtures: Record<string, unknown> = {
  '/api/v1/status': status,
  '/api/v1/campaigns': [{ campaign_id: 'campaign-1', display_name: 'Marcia’s campaign', game_seed: '951', participant_guid: '41', identity_method: 'game_seed_participant', identity_confidence: 'user_confirmed', created_at: new Date().toISOString(), archived_at: null }],
  '/api/v1/areas': { campaign_id: 'campaign-1', items: [{ ...areaBase, area_pk: 1, area_id: '8513', name: 'Juliana', region_guid: '3225', game_session_guid: '3245', region_evidence: 'current_camera_area_same_snapshot', first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), position: { x: .3, y: .4 } }, { ...areaBase, area_pk: 2, area_id: '8961', name: 'Naissus', region_guid: '3225', game_session_guid: '3245', region_evidence: 'current_camera_area_same_snapshot', first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), position: { x: .7, y: .6 } }, { ...areaBase, area_pk: 3, area_id: '8451', name: 'Cudslip', region_guid: '6626', game_session_guid: '6569', region_evidence: 'current_camera_area_same_snapshot', first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), position: null, position_source: null, manual_placement: false }] },
  '/api/v1/inventory/latest': inventory,
  '/api/v1/areas/1/stock-planning': stockPlanning,
  '/api/v1/areas/2/stock-planning': { ...stockPlanning, area: { ...stockPlanning.area, area_pk: 2, area_name: 'Naissus' } },
  '/api/v1/areas/3/stock-planning': { ...stockPlanning, area: { ...stockPlanning.area, area_pk: 3, area_name: 'Cudslip', region_guid: '6626' } },
  '/api/v1/dashboard/overview': overview,
  '/api/v1/trade/opportunities': trade,
  '/api/v1/trade/routes': activeTradeRoutes,
  '/api/v1/trade/network': tradeNetwork,
  '/api/v1/production/chains': { meta, catalog: { ...catalog, recipes: 1 }, chains: [{ recipe_id: 'factory:2955', name: 'Fishing Hut', building_guid: '2955', building_name: 'Fishing Hut', workforce_guid: '2181', workforce_name: 'Libertus Workforce', cycle_seconds: 60, items: [{ role: 'output', ordinal: 1, product_guid: '2174', product_name: 'Timber', amount: 1 }], inferred_pressures: [], associated_regions: ['Roman'], base_maintenance: 6, city_states: [{ area_pk: 1, area_name: 'Juliana', region_guid: '3225', building_count: 2, presence_status: 'installed', observed_at: meta.observed_at, inferred_pressures: [], stocks: [{ role: 'output', ordinal: 1, product_guid: '2174', product_name: 'Timber', amount: 1, stock: 92, capacity: 100, fill_ratio: .92, net_stock_change: { net_stock_change_per_minute: 4, interval_count: 5, window_minutes: 5, confidence: 'measured_history' } }] }], measurement_notice: 'Stock-based inferred pressure; no measured factory rate.' }] },
  '/api/v1/production/explorer': productionExplorer,
  '/api/v1/finance': { meta, finance: overview.finance, balance_analysis: overview.balance_analysis },
  '/api/v1/finance/history': { meta, items: [{ observed_at: meta.observed_at, treasury: 3_756_154, reported_balance: 200 }] },
  '/api/v1/trade-plans': { campaign_id: 'campaign-1', items: [tradePlan] },
  '/api/v1/actions': { campaign_id: 'campaign-1', items: overview.actions },
  '/api/v1/workforce': { meta, scope: 'current_camera_area', items: overview.workforce_shortages },
  '/api/v1/policies': { campaign_id: 'campaign-1', items: [] },
}
