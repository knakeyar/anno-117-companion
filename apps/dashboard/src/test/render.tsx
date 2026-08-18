import type { ReactElement } from 'react'
import { render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import { apiFixtures } from './fixtures'

export function installFetchMock(overrides: Record<string, unknown> = {}) {
  const fixtures = { ...apiFixtures, ...overrides }
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const url = new URL(target, 'http://localhost')
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const body = init?.body?.toString() ?? (input instanceof Request ? await input.clone().text() : '')
    if (method === 'PUT' && url.pathname === '/api/v1/policies') {
      return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    if (method === 'PATCH' && url.pathname.startsWith('/api/v1/campaigns/')) {
      const parsed = JSON.parse(body)
      return Response.json({ campaign_id: 'campaign-1', display_name: parsed.display_name })
    }
    if (method === 'PATCH' && url.pathname === '/api/v1/campaigns') {
      const parsed = JSON.parse(body)
      return Response.json({
        campaign_id: parsed.campaign_id,
        display_name: 'Assigned campaign',
        play_session_id: parsed.play_session_id,
      })
    }
    if (method === 'POST' && url.pathname === '/api/v1/trade-plans') {
      const parsed = JSON.parse(body)
      return Response.json({ trade_plan_id: 'plan-new', campaign_id: parsed.campaign_id, source_area_pk: parsed.source_area_pk, source_area_name: 'Juliana', destination_area_pk: parsed.destination_area_pk, destination_area_name: 'Naissus', status: 'planned', plan_kind: parsed.plan_kind, route_tag: 'AC-NEW1', suggested_route_name: 'AC-NEW1 Jul-Nai', usable_ship_capacity: parsed.usable_ship_capacity, cargo_slots: parsed.cargo_slots, cargo_slot_capacity: 50, expected_round_trip_minutes: parsed.expected_round_trip_minutes, ship_cost: parsed.ship_cost, total_slots_required: 1, estimated_required_ships: 1, estimated_fleet_cost: parsed.ship_cost, capacity_basis: 'one_time_single_wave', quantity_unit: parsed.plan_kind === 'recurring_supply' ? 'tons_per_minute' : 'tons_total', runtime_status: 'not_detected', runtime_freshness: 'historical', goods_verification: 'planned_only', last_runtime_match_at: null, reason: parsed.reason, evidence: parsed.evidence, goods: parsed.goods, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    }
    if (method === 'POST' && url.pathname === '/api/v1/trade/route-links') {
      const parsed = JSON.parse(body)
      return Response.json({ link_id: 'link-1', ...parsed, route_name: 'Bread Cud - Rhy', ship_ids: ['8121'], trade_plan_id: parsed.trade_plan_id ?? null, source_area_name: 'Juliana', destination_area_name: 'Cudslip', link_method: 'manual', first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    }
    if (method === 'DELETE' && url.pathname.startsWith('/api/v1/trade/route-links/')) {
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/api/v1/inventory/history') {
      return Response.json({ items: [] })
    }
    if (url.pathname === '/api/v1/inventory/history/group') {
      return Response.json({ series: url.searchParams.getAll('product_guid').map((productGuid) => ({ product_guid: productGuid, items: [] })) })
    }
    const variantKey = url.pathname === '/api/v1/trade/opportunities'
      ? `${url.pathname}?plan_kind=${url.searchParams.get('plan_kind') ?? 'emergency_transfer'}`
      : url.pathname
    const fixture = fixtures[variantKey] ?? fixtures[url.pathname]
    if (fixture === undefined) return new Response('Not found', { status: 404 })
    return Response.json(fixture)
  })
}

export function renderApp(element: ReactElement, route = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  window.history.pushState({}, '', route)
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>{element}</MemoryRouter>
    </QueryClientProvider>,
  )
}
