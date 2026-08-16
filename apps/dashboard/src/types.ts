export interface ObservationMeta {
  snapshot_id: number | null
  play_session_id: string | null
  observed_at: string | null
  scope: string | null
  freshness_seconds: number | null
  is_stale: boolean
}

export interface CatalogSummary {
  release_id: string | null
  label?: string
  source_hash?: string
  products: number
  telemetry_products?: number
  factories?: number
  recipes: number
  coverage: 'missing' | 'starter' | 'partial' | 'complete'
  coverage_note?: string | null
}

export interface Velocity {
  net_stock_change_per_minute: number
  interval_count: number
  window_minutes: number
  confidence: string
}

export interface InventoryItem {
  area_pk: number
  area_id: string
  area_name: string
  region_guid: string | null
  product_guid: string
  product_name: string
  category: string | null
  stock: number | null
  available_stock: number | null
  capacity: number | null
  reserved: number | null
  fill_ratio: number | null
  free_space_raw: number | null
  engine_trend_raw: number | null
  passive_trade_minimum: number | null
  passive_trade_mode: 'none' | 'buy' | 'sell' | 'buy_or_sell' | 'unknown'
  passive_trade_flags: Record<string, boolean | null>
  low_target: number | null
  high_target: number | null
  policy_source: 'explicit' | 'passive_trade' | 'capacity_default'
  priority: number
  excluded: boolean
  velocity: Velocity | null
  estimated_stockout_minutes: number | null
}

export interface ManagementSignal {
  code: 'low_stock' | 'near_full' | 'falling_stock' | 'estimated_stockout'
  severity: 'critical' | 'warning' | 'info'
  label: string
  area_pk: number
  area_name: string
  product_guid: string
  product_name: string
  priority: number
  evidence: Record<string, number | null>
  interpretation: 'inferred_pressure'
  chain_role?: 'input' | 'output'
  chain_issue?: 'input_pressure' | 'output_blockage'
}

export interface InventoryResponse {
  meta: ObservationMeta
  catalog: CatalogSummary
  items: InventoryItem[]
  signals: ManagementSignal[]
}

export interface TransferCandidate {
  product_guid: string
  product_name: string
  source_area_pk: number
  source_area_name: string
  destination_area_pk: number
  destination_area_name: string
  advisory_amount: number
  source_available_stock: number
  source_high_target: number
  projected_source_stock: number
  destination_available_stock: number
  destination_low_target: number
  projected_destination_stock: number
  destination_priority: number
  route_feasibility: 'unknown'
  interpretation: 'transfer_candidate'
}

export interface TradeResponse {
  meta: ObservationMeta
  catalog: CatalogSummary
  items: TransferCandidate[]
  suggested_routes: SuggestedRoute[]
  notice: string
}

export interface ActiveTradeRouteShip {
  ship_id: string
  ship_name: string | null
  ship_guid: string | null
  game_session_guid: string | null
  area_id: string | null
  is_paused: boolean | null
  on_regular_route: boolean | null
  loading_speed_factor: number | null
}

export interface ActiveTradeRoute {
  route_key: string
  route_name: string
  identity_scope: 'mutable_route_name'
  evidence_kind: 'assigned_ships' | 'issue_only'
  status: 'running' | 'partially_paused' | 'paused' | 'issue_reported'
  is_active_last_observed: boolean | null
  assigned_ship_count: number | null
  paused_ship_count: number | null
  regular_ship_count: number | null
  game_session_guid: string | null
  region_guid: string | null
  observed_at: string | null
  freshness_seconds: number | null
  is_stale: boolean
  freshness?: 'live' | 'stale' | 'historical' | null
  relink_suggestions?: Array<{ link_id: string; previous_route_name: string; overlapping_ship_ids: string[]; requires_confirmation: true }>
  issues: RouteIssue[]
  ships: ActiveTradeRouteShip[]
}

export interface ActiveTradeRoutesResponse {
  meta: ObservationMeta
  campaign_id: string | null
  telemetry_status: 'success' | 'failed' | 'not_observed'
  scope: string
  identity_notice: string
  capabilities: {
    assigned_ships: boolean
    route_issues: boolean
    stops: boolean
    configured_goods: boolean
    ship_cargo: boolean
  }
  counts: {
    ship_backed_routes: number
    issue_only_routes: number
    assigned_ships: number
  }
  items: ActiveTradeRoute[]
}

export type TradeNetworkStatus = 'running' | 'partially_paused' | 'paused' | 'issue' | 'planned' | 'inactive' | 'historical' | 'unknown'

export interface TradeNetworkNode {
  node_id: string
  area_pk: number
  area_name: string
  region: 'latium' | 'albion' | null
  severity: 'critical' | 'warning' | 'stable'
  pressure_count: number
  route_issue_count: number
  running_route_count: number
  paused_route_count: number
  planned_route_count: number
  stock_health: {
    tracked_goods: number
    average_fill_ratio: number | null
    critical: number
    warning: number
  }
  important_goods: Array<{
    product_guid: string
    product_name: string
    stock: number | null
    capacity: number | null
    fill_ratio: number | null
    net_stock_change_per_minute: number | null
  }>
  pressure_signals: ManagementSignal[]
}

export interface TradeNetworkPlanEvidence {
  trade_plan_id: string
  plan_kind: 'emergency_transfer' | 'recurring_supply'
  workflow_status: string
  runtime_status: string
  runtime_freshness: string
  route_tag: string | null
  suggested_route_name: string | null
  reason: string | null
  goods: Array<{ product_guid: string; product_name: string | null; amount: number; evidence_kind: 'planned'; trade_plan_id: string }>
}

export interface TradeNetworkEdge {
  edge_id: string
  source_area_pk: number
  source_area_name: string
  destination_area_pk: number
  destination_area_name: string
  scope: 'latium' | 'albion' | 'cross_region' | 'unknown'
  status: TradeNetworkStatus
  severity: 'critical' | 'warning' | 'stable'
  freshness: 'live' | 'stale' | 'historical'
  goods_verification: 'planned_only' | 'configured' | 'unavailable'
  endpoint_evidence: Array<{ kind: string; trade_plan_id?: string; link_id?: string }>
  plans: TradeNetworkPlanEvidence[]
  routes: ActiveTradeRoute[]
  ships: ActiveTradeRouteShip[]
  planned_goods: TradeNetworkPlanEvidence['goods']
  configured_goods: Array<Record<string, unknown>>
  cargo_aboard: Array<Record<string, unknown>>
  issues: RouteIssue[]
  actions: Array<Record<string, unknown>>
  summary: { goods: number; routes: number; ships: number; plans: number }
}

export interface TradeNetworkGraph {
  nodes: TradeNetworkNode[]
  edges: TradeNetworkEdge[]
}

export interface TradeNetworkResponse {
  meta: ObservationMeta
  catalog: CatalogSummary
  campaign_id: string | null
  graphs: {
    latium: TradeNetworkGraph
    albion: TradeNetworkGraph
    cross_region: TradeNetworkGraph
  }
  unmapped_routes: ActiveTradeRoute[]
  capabilities: ActiveTradeRoutesResponse['capabilities']
  evidence_notice: string
}

export interface TradeRouteLink {
  link_id: string
  campaign_id: string
  route_key: string
  route_name: string
  ship_ids: string[]
  trade_plan_id: string | null
  source_area_pk: number
  source_area_name: string
  destination_area_pk: number
  destination_area_name: string
  link_method: 'tag' | 'manual'
  first_seen_at: string
  last_seen_at: string
  updated_at: string
}

export interface Finance {
  participant_guid: string
  treasury: number | null
  total_balance_raw: number | null
  trade_balance_period_raw: number | null
  passive_trade_balance_period_raw: number | null
  active_trade_balance_period_raw: number | null
  categories: Array<{
    kind: string
    ordinal: number
    category_guid_raw: string | null
    localized_label: string | null
    value: number | null
  }>
}

export interface FinanceAnalysis {
  reported_balance: number | null
  reported_balance_is_negative: boolean
  treasury: number | null
  treasury_is_falling: boolean
  treasury_change: number | null
  treasury_change_per_game_minute: number | null
  trade_balance: { total: number | null; passive: number | null; active: number | null }
  category_totals: {
    gross_income: number
    gross_expenses: number
    net_profit: number
    interpretation: 'sum_of_observed_finance_categories'
  }
  largest_positive_categories: Finance['categories']
  largest_negative_categories: Finance['categories']
  estimated_base_maintenance: {
    total: number
    notice: string
    cities: Array<{
      area_pk: number
      area_name: string
      estimated_base_maintenance: number
      factories: Array<{
        building_guid: string
        building_name: string
        count: number
        base_maintenance_each: number
        estimated_base_maintenance: number
      }>
    }>
  }
  guidance: Array<{ code: string; title: string; suggestion: string; evidence: Record<string, unknown> }>
}

export interface WorkforceItem {
  area_pk: number
  area_name: string
  scope: 'current_camera_area'
  workforce_guid: string
  name: string | null
  population_count: number | null
  resulting_from_population: number | null
  registered_production: number | null
  registered_consumption: number | null
  delta_without_buffs: number | null
  delta_with_buffs: number | null
}

export interface RouteIssue {
  route_name: string | null
  issue_code: string
  engine_error_code: number | null
  label: string
  guidance: string
  severity: 'critical' | 'warning'
  active_error_count: number | null
  identity_scope: 'ephemeral_route_name'
}

export interface OverviewResponse {
  meta: ObservationMeta
  catalog: CatalogSummary
  finance: Finance | null
  balance_analysis: FinanceAnalysis | null
  actions: ManagementAction[]
  suggested_routes: SuggestedRoute[]
  signals: ManagementSignal[]
  transfer_candidates: TransferCandidate[]
  route_issues: RouteIssue[]
  workforce_shortages: WorkforceItem[]
  counts: {
    inventory_items: number
    signals: number
    transfer_candidates: number
  }
  language: {
    rate_label: 'Net stock change'
    pressure_label: 'Inferred pressure'
  }
}

export interface Area {
  area_pk: number
  area_id: string
  name: string
  region_guid: string | null
  game_session_guid: string | null
  region_evidence: string | null
  first_seen_at: string
  last_seen_at: string
  persistent: boolean
  telemetry_active: boolean
  position: { x: number; y: number } | null
  position_source: 'manual' | 'telemetry' | null
  location_status: 'success' | 'not_observed' | 'failed'
  location_error: string | null
  manual_placement: boolean
  latest_observation: { observed_at: string; is_historical: boolean }
}

export interface Campaign {
  campaign_id: string
  display_name: string
  game_seed: string | null
  participant_guid: string | null
  identity_method: string
  identity_confidence: string
  created_at: string
  archived_at: string | null
}

export interface Policy {
  campaign_id: string
  area_pk: number
  product_guid: string
  low_target: number | null
  high_target: number | null
  priority: number
  excluded: boolean
  updated_at?: string
}

export interface HistoryPoint {
  snapshot_id: number
  observed_at: string
  play_time: number | null
  stock: number | null
  available_stock: number | null
  capacity: number | null
}

export interface RecipeItem {
  role: 'input' | 'output'
  ordinal: number
  product_guid: string
  product_name: string | null
  amount: number
}

export interface ProductionChain {
  recipe_id: string
  name: string
  building_guid: string
  building_name: string | null
  workforce_guid: string | null
  workforce_name: string | null
  cycle_seconds: number | null
  items: RecipeItem[]
  inferred_pressures: ManagementSignal[]
  associated_regions: string[]
  base_maintenance: number | null
  city_states: ChainCityState[]
  measurement_notice: string
}

export interface ChainCityState {
  area_pk: number
  area_name: string
  region_guid: string | null
  building_count: number | null
  presence_status: 'installed' | 'not_installed' | 'unknown'
  observed_at: string | null
  inferred_pressures: ManagementSignal[]
  stocks: Array<RecipeItem & { stock: number | null; capacity: number | null; fill_ratio: number | null; net_stock_change: Velocity | null }>
}

export interface SuggestedRoute {
  suggestion_id: string
  action_id: string
  source_area_pk: number
  source_area_name: string
  destination_area_pk: number
  destination_area_name: string
  goods: Array<{
    product_guid: string
    product_name: string
    advisory_amount: number
    active_production_input?: boolean
    imminent_stockout?: boolean
    source_available_stock?: number
    source_high_target?: number
    projected_source_stock?: number
    destination_available_stock?: number
    destination_low_target?: number
    projected_destination_stock?: number
  }>
  confidence: 'high' | 'medium' | 'low'
  reason: string
  evidence: Record<string, unknown>
  route_feasibility: 'unknown'
}

export interface ManagementAction {
  action_id: string
  campaign_id: string
  kind: string
  severity: 'critical' | 'warning' | 'info'
  title: string
  summary: string
  evidence: Record<string, unknown>
  deep_link: string | null
  status: 'active' | 'accepted' | 'snoozed' | 'dismissed' | 'completed' | 'resolved'
  snoozed_until: string | null
  first_seen_at: string
  last_seen_at: string
  resolved_at: string | null
}

export interface TradePlan {
  trade_plan_id: string
  campaign_id: string
  source_area_pk: number
  source_area_name: string
  destination_area_pk: number
  destination_area_name: string
  status: 'planned' | 'implemented' | 'implemented_unverified' | 'completed' | 'dismissed'
  plan_kind: 'emergency_transfer' | 'recurring_supply'
  route_tag: string
  suggested_route_name: string
  usable_ship_capacity: number | null
  expected_round_trip_minutes: number | null
  estimated_required_ships: number | null
  runtime_status: 'not_detected' | 'running' | 'partially_paused' | 'paused' | 'issue' | 'inactive' | 'ambiguous'
  runtime_freshness: 'live' | 'stale' | 'historical'
  goods_verification: 'planned_only' | 'configured_match' | 'configured_mismatch' | 'cargo_partial' | 'unavailable'
  last_runtime_match_at: string | null
  reason: string | null
  evidence: Record<string, unknown>
  goods: Array<{ product_guid: string; product_name: string | null; amount: number }>
  created_at: string
  updated_at: string
}

export interface AdvisorConversation {
  conversation_id: string
  campaign_id: string
  title: string | null
  available?: boolean
  error?: string | null
  messages: Array<{ message_id: number; role: 'user' | 'assistant'; content: string; action_ids: string[]; created_at: string }>
}

export interface StatusResponse {
  service: string
  status: string
  database: { path: string; exists: boolean; size_bytes: number; journal_mode: string }
  telemetry: {
    directory: string
    glob: string
    parse_error_count: number
    sources: Array<{
      path: string
      fingerprint: string
      byte_offset: number
      file_size: number
      last_read_at: string | null
      last_error: string | null
    }>
  }
  play_session: null | {
    play_session_id: string
    campaign_id: string | null
    load_epoch: number
    mod_version: string | null
    game_seed: string | null
    started_at: string
  }
  latest_snapshot: ObservationMeta
  catalog: CatalogSummary
  selected_campaign_id: string | null
  advisor: { configured: boolean; model: string; reasoning_effort: string; on_demand_only: boolean }
}
