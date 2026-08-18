import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import createClient from 'openapi-fetch'
import type { paths } from './generated/openapi'
import type {
  Area,
  Campaign,
  CityStockPlanningResponse,
  AdvisorConversation,
  ActiveTradeRoutesResponse,
  Finance,
  FinanceAnalysis,
  HistoryPoint,
  HistorySeries,
  InventoryResponse,
  ObservationMeta,
  OverviewResponse,
  Policy,
  ManagementAction,
  ProductionChain,
  ProductionExplorerResponse,
  StatusResponse,
  TradeResponse,
  TradePlan,
  TradeNetworkResponse,
  TradeRouteLink,
  WorkforceItem,
} from './types'

const client = createClient<paths>({
  baseUrl: typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
  fetch: (request) => globalThis.fetch(request),
})

export interface ShipPlanAssumptions {
  cargoSlots: number
  expectedRoundTripMinutes: number | null
  shipCost: number | null
}

async function unwrap<T>(pending: Promise<unknown>): Promise<T> {
  const result = await pending as { data?: unknown; error?: unknown; response: Response }
  if (!result.response.ok || result.error !== undefined) {
    const detail = typeof result.error === 'string'
      ? result.error
      : JSON.stringify(result.error ?? result.response.statusText)
    throw new Error(detail || `${result.response.status} ${result.response.statusText}`)
  }
  return result.data as T
}

export const api = {
  status: () => unwrap<StatusResponse>(client.GET('/api/v1/status')),
  campaigns: () => unwrap<Campaign[]>(client.GET('/api/v1/campaigns')),
  renameCampaign: (campaignId: string, displayName: string) =>
    unwrap<{ campaign_id: string; display_name: string }>(client.PATCH('/api/v1/campaigns/{campaign_id}', {
      params: { path: { campaign_id: campaignId } },
      body: { display_name: displayName },
    })),
  assignCampaign: (campaignId: string, playSessionId: string) =>
    unwrap<{ campaign_id: string; display_name: string; play_session_id: string }>(client.PATCH('/api/v1/campaigns', {
      body: { campaign_id: campaignId, play_session_id: playSessionId },
    })),
  selectCampaign: (campaignId: string) => unwrap<{ campaign_id: string }>(client.PUT('/api/v1/settings/active-campaign', { body: { campaign_id: campaignId } })),
  areas: () => unwrap<{ campaign_id: string | null; items: Area[] }>(client.GET('/api/v1/areas')),
  setMapPosition: (areaPk: number, body: { region_guid?: string; x?: number; y?: number; clear?: boolean }) =>
    unwrap<Area>(client.PUT('/api/v1/areas/{area_pk}/map-position', { params: { path: { area_pk: areaPk } }, body: { ...body, clear: body.clear ?? false } })),
  inventory: () => unwrap<InventoryResponse>(client.GET('/api/v1/inventory/latest')),
  stockPlanning: (areaPk: number) =>
    unwrap<CityStockPlanningResponse>(client.GET('/api/v1/areas/{area_pk}/stock-planning', {
      params: { path: { area_pk: areaPk } },
    })),
  history: (areaPk: number, productGuid: string) =>
    unwrap<{ items: HistoryPoint[] }>(client.GET('/api/v1/inventory/history', {
      params: { query: { area_pk: areaPk, product_guid: productGuid } },
    })),
  historyGroup: (areaPk: number, productGuids: string[]) =>
    unwrap<{ items?: never; series: HistorySeries[] }>(client.GET('/api/v1/inventory/history/group', {
      params: { query: { area_pk: areaPk, product_guid: productGuids } },
    })),
  overview: () => unwrap<OverviewResponse>(client.GET('/api/v1/dashboard/overview')),
  trade: (
    planKind: TradePlan['plan_kind'] = 'emergency_transfer',
    recurringSafetyMargin = 0.2,
  ) => unwrap<TradeResponse>(client.GET('/api/v1/trade/opportunities', {
    params: { query: { plan_kind: planKind, recurring_safety_margin: recurringSafetyMargin } },
  })),
  activeTradeRoutes: () => unwrap<ActiveTradeRoutesResponse>(client.GET('/api/v1/trade/routes')),
  tradeNetwork: () => unwrap<TradeNetworkResponse>(client.GET('/api/v1/trade/network')),
  tradePlans: () => unwrap<{ campaign_id: string | null; items: TradePlan[] }>(client.GET('/api/v1/trade-plans')),
  createTradePlan: (
    route: TradeResponse['suggested_routes'][number],
    campaignId: string,
    assumptions: ShipPlanAssumptions,
  ) => unwrap<TradePlan>(client.POST('/api/v1/trade-plans', { body: {
    campaign_id: campaignId,
    source_area_pk: route.source_area_pk,
    destination_area_pk: route.destination_area_pk,
    goods: route.goods.flatMap((item) => item.advisory_amount == null
      ? []
      : [{ product_guid: item.product_guid, amount: item.advisory_amount }]),
    reason: route.reason,
    evidence: {
      ...route.evidence,
      ship_assumptions: {
        cargo_slots: assumptions.cargoSlots,
        cargo_slot_capacity_tons: 50,
        expected_round_trip_minutes: assumptions.expectedRoundTripMinutes,
        ship_cost: assumptions.shipCost,
      },
    },
    plan_kind: route.plan_kind,
    cargo_slots: assumptions.cargoSlots,
    usable_ship_capacity: assumptions.cargoSlots * 50,
    expected_round_trip_minutes: assumptions.expectedRoundTripMinutes,
    ship_cost: assumptions.shipCost,
  } })),
  patchTradePlan: (tradePlanId: string, status: TradePlan['status']) => unwrap<TradePlan>(client.PATCH('/api/v1/trade-plans/{trade_plan_id}', { params: { path: { trade_plan_id: tradePlanId } }, body: { status } })),
  linkTradeRoute: (body: { campaign_id: string; route_key: string; source_area_pk: number; destination_area_pk: number; trade_plan_id?: string }) =>
    unwrap<TradeRouteLink>(client.POST('/api/v1/trade/route-links', { body })),
  unlinkTradeRoute: (linkId: string) => unwrap<void>(client.DELETE('/api/v1/trade/route-links/{link_id}', { params: { path: { link_id: linkId } } })),
  relinkTradeRoute: (linkId: string, routeKey: string) => unwrap<TradeRouteLink>(client.PATCH('/api/v1/trade/route-links/{link_id}', { params: { path: { link_id: linkId } }, body: { route_key: routeKey } })),
  actions: () => unwrap<{ campaign_id: string | null; items: ManagementAction[] }>(client.GET('/api/v1/actions')),
  patchAction: (actionId: string, status: 'active' | 'accepted' | 'snoozed' | 'dismissed' | 'completed') => unwrap<ManagementAction>(client.PATCH('/api/v1/actions/{action_id}', { params: { path: { action_id: actionId } }, body: { status } })),
  chains: () =>
    unwrap<{ meta: ObservationMeta; catalog: InventoryResponse['catalog']; chains: ProductionChain[] }>(
      client.GET('/api/v1/production/chains'),
    ),
  productionExplorer: (areaPk: number, productGuid?: string | null, recipeOverrides: string[] = []) =>
    unwrap<ProductionExplorerResponse>(client.GET('/api/v1/production/explorer', {
      params: { query: {
        area_pk: areaPk,
        ...(productGuid ? { product_guid: productGuid } : {}),
        ...(recipeOverrides.length ? { recipe_override: recipeOverrides } : {}),
      } },
    })),
  finance: () => unwrap<{ meta: ObservationMeta; finance: Finance | null; balance_analysis: FinanceAnalysis | null }>(client.GET('/api/v1/finance')),
  financeHistory: () => unwrap<{ meta: ObservationMeta; items: Array<{ observed_at: string; treasury: number | null; reported_balance: number | null }> }>(client.GET('/api/v1/finance/history')),
  workforce: () =>
    unwrap<{ meta: ObservationMeta; scope: string; items: WorkforceItem[] }>(client.GET('/api/v1/workforce')),
  policies: () => unwrap<{ campaign_id: string | null; items: Policy[] }>(client.GET('/api/v1/policies')),
  putPolicy: (policy: Policy) =>
    unwrap<Policy>(client.PUT('/api/v1/policies', {
      body: policy,
    })),
  askAdvisor: (question: string, conversationId?: string) => unwrap<AdvisorConversation>(client.POST('/api/v1/advisor/messages', { body: { question, conversation_id: conversationId } })),
  deleteConversation: (conversationId: string) => unwrap<void>(client.DELETE('/api/v1/advisor/conversations/{conversation_id}', { params: { path: { conversation_id: conversationId } } })),
}

export const queryKeys = {
  status: ['status'] as const,
  campaigns: ['campaigns'] as const,
  areas: ['areas'] as const,
  inventory: ['inventory'] as const,
  stockPlanning: (areaPk: number) => ['stock-planning', areaPk] as const,
  overview: ['overview'] as const,
  tradeRoot: ['trade'] as const,
  trade: (planKind: TradePlan['plan_kind'], recurringSafetyMargin: number) =>
    ['trade', planKind, recurringSafetyMargin] as const,
  activeTradeRoutes: ['active-trade-routes'] as const,
  tradeNetwork: ['trade-network'] as const,
  tradePlans: ['trade-plans'] as const,
  actions: ['actions'] as const,
  chains: ['chains'] as const,
  productionExplorer: (areaPk: number, productGuid: string | null, recipeOverrides: string[]) =>
    ['production-explorer', areaPk, productGuid, [...recipeOverrides].sort().join('|')] as const,
  finance: ['finance'] as const,
  financeHistory: ['finance-history'] as const,
  workforce: ['workforce'] as const,
  policies: ['policies'] as const,
  history: (areaPk: number, productGuid: string) => ['history', areaPk, productGuid] as const,
  historyGroup: (areaPk: number, productGuids: string[]) => ['history-group', areaPk, [...productGuids].sort().join(',')] as const,
}

const queryOptions = { refetchInterval: 30_000, staleTime: 10_000, retry: 2 }

export const useStatus = () => useQuery({ queryKey: queryKeys.status, queryFn: api.status, ...queryOptions })
export const useCampaigns = () => useQuery({ queryKey: queryKeys.campaigns, queryFn: api.campaigns })
export const useAreas = () => useQuery({ queryKey: queryKeys.areas, queryFn: api.areas, ...queryOptions })
export const useInventory = () =>
  useQuery({ queryKey: queryKeys.inventory, queryFn: api.inventory, ...queryOptions })
export const useStockPlanning = (areaPk: number) =>
  useQuery({
    queryKey: queryKeys.stockPlanning(areaPk),
    queryFn: () => api.stockPlanning(areaPk),
    enabled: Boolean(areaPk),
    ...queryOptions,
  })
export const useOverview = () =>
  useQuery({ queryKey: queryKeys.overview, queryFn: api.overview, ...queryOptions })
export const useTrade = (
  planKind: TradePlan['plan_kind'] = 'emergency_transfer',
  recurringSafetyMargin = 0.2,
) => useQuery({
  queryKey: queryKeys.trade(planKind, recurringSafetyMargin),
  queryFn: () => api.trade(planKind, recurringSafetyMargin),
  ...queryOptions,
})
export const useActiveTradeRoutes = () => useQuery({ queryKey: queryKeys.activeTradeRoutes, queryFn: api.activeTradeRoutes, ...queryOptions })
export const useTradeNetwork = () => useQuery({ queryKey: queryKeys.tradeNetwork, queryFn: api.tradeNetwork, ...queryOptions })
export const useTradePlans = () => useQuery({ queryKey: queryKeys.tradePlans, queryFn: api.tradePlans, ...queryOptions })
export const useActions = () => useQuery({ queryKey: queryKeys.actions, queryFn: api.actions, ...queryOptions })
export const useChains = () =>
  useQuery({ queryKey: queryKeys.chains, queryFn: api.chains, ...queryOptions })
export const useProductionExplorer = (areaPk: number, productGuid: string | null, recipeOverrides: string[] = []) =>
  useQuery({
    queryKey: queryKeys.productionExplorer(areaPk, productGuid, recipeOverrides),
    queryFn: () => api.productionExplorer(areaPk, productGuid, recipeOverrides),
    enabled: Boolean(areaPk),
    ...queryOptions,
  })
export const useFinance = () =>
  useQuery({ queryKey: queryKeys.finance, queryFn: api.finance, ...queryOptions })
export const useFinanceHistory = () => useQuery({ queryKey: queryKeys.financeHistory, queryFn: api.financeHistory, ...queryOptions })
export const useWorkforce = () =>
  useQuery({ queryKey: queryKeys.workforce, queryFn: api.workforce, ...queryOptions })
export const usePolicies = () => useQuery({ queryKey: queryKeys.policies, queryFn: api.policies })
export const useHistory = (areaPk: number, productGuid: string) =>
  useQuery({
    queryKey: queryKeys.history(areaPk, productGuid),
    queryFn: () => api.history(areaPk, productGuid),
    enabled: Boolean(areaPk && productGuid),
  })

export const useHistoryGroup = (areaPk: number, productGuids: string[]) =>
  useQuery({
    queryKey: queryKeys.historyGroup(areaPk, productGuids),
    queryFn: () => api.historyGroup(areaPk, productGuids),
    enabled: Boolean(areaPk && productGuids.length),
  })

export function useCompanionMutations() {
  const queries = useQueryClient()
  const refresh = () => queries.invalidateQueries()
  return {
    mapPosition: useMutation({ mutationFn: ({ areaPk, ...body }: { areaPk: number; region_guid?: string; x?: number; y?: number; clear?: boolean }) => api.setMapPosition(areaPk, body), onSuccess: refresh }),
    createTradePlan: useMutation({ mutationFn: ({ route, campaignId, assumptions }: { route: TradeResponse['suggested_routes'][number]; campaignId: string; assumptions: ShipPlanAssumptions }) => api.createTradePlan(route, campaignId, assumptions), onSuccess: refresh }),
    patchTradePlan: useMutation({ mutationFn: ({ id, status }: { id: string; status: TradePlan['status'] }) => api.patchTradePlan(id, status), onSuccess: refresh }),
    linkTradeRoute: useMutation({ mutationFn: (body: { campaign_id: string; route_key: string; source_area_pk: number; destination_area_pk: number; trade_plan_id?: string }) => api.linkTradeRoute(body), onSuccess: refresh }),
    unlinkTradeRoute: useMutation({ mutationFn: (linkId: string) => api.unlinkTradeRoute(linkId), onSuccess: refresh }),
    relinkTradeRoute: useMutation({ mutationFn: ({ linkId, routeKey }: { linkId: string; routeKey: string }) => api.relinkTradeRoute(linkId, routeKey), onSuccess: refresh }),
    patchAction: useMutation({ mutationFn: ({ id, status }: { id: string; status: 'active' | 'accepted' | 'snoozed' | 'dismissed' | 'completed' }) => api.patchAction(id, status), onSuccess: refresh }),
  }
}

export function useLiveTelemetry(): void {
  const queryClient = useQueryClient()
  useEffect(() => {
    const events = new EventSource('/events')
    const refresh = () => {
      void queryClient.invalidateQueries()
    }
    events.addEventListener('snapshot_completed', refresh)
    return () => {
      events.removeEventListener('snapshot_completed', refresh)
      events.close()
    }
  }, [queryClient])
}
