import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../App'
import { calculateProductionLayout } from '../components/productionChainLayout'
import { calculateTradeLayout, selectTradeHub } from '../components/tradeNetworkLayout'
import { inventory, overview, productionExplorer, stockPlanning, trade, tradeNetwork } from './fixtures'
import { installFetchMock, renderApp } from './render'

describe('first-class management dashboard', () => {
  it('shows actionable command-center evidence and honest scope language', async () => {
    installFetchMock()
    renderApp(<App />)
    expect(await screen.findByRole('heading', { name: 'Decide what to fix next.' })).toBeInTheDocument()
    expect(screen.getByText('Move Timber from observed surplus.')).toBeInTheDocument()
    expect(screen.getAllByRole('region', { name: 'Trade network' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Latium' })).toHaveClass('active')
    expect(screen.getByRole('group', { name: 'Graph layout' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Ask advisor/i }).length).toBeGreaterThan(0)
    expect(screen.queryByText(/measured production rate/i)).not.toBeInTheDocument()
  })

  it('offers orthogonal network, radial hubs, and a selected-city focus layout', async () => {
    const graph = tradeNetwork.graphs.latium
    const first = await calculateTradeLayout(graph, 'latium', 'network')
    const second = await calculateTradeLayout(graph, 'latium', 'network')
    expect(first.nodes.map((node) => node.position)).toEqual(second.nodes.map((node) => node.position))
    expect(first.nodes.length).toBeGreaterThan(1)
    expect(first.nodes.some((node, index) => first.nodes.slice(index + 1).some((candidate) => Math.abs(node.position.x - candidate.position.x) < 240 && Math.abs(node.position.y - candidate.position.y) < 128))).toBe(false)
    expect(first.routes[graph.edges[0].edge_id].points.length).toBeGreaterThanOrEqual(2)

    const baseEdge = graph.edges[0]
    const cycleGraph = {
      nodes: tradeNetwork.graphs.cross_region.nodes,
      edges: [
        baseEdge,
        { ...baseEdge, edge_id: 'campaign-1:2:3', source_area_pk: 2, source_area_name: 'Naissus', destination_area_pk: 3, destination_area_name: 'Cudslip', scope: 'cross_region' as const },
        { ...baseEdge, edge_id: 'campaign-1:3:1', source_area_pk: 3, source_area_name: 'Cudslip', destination_area_pk: 1, destination_area_name: 'Juliana', scope: 'cross_region' as const },
      ],
    }
    const orthogonal = await calculateTradeLayout(cycleGraph, 'cross_region', 'network')
    expect(Object.keys(orthogonal.routes)).toHaveLength(3)
    expect(Math.max(...orthogonal.nodes.filter((node) => node.data.region === 'latium').map((node) => node.position.x))).toBeLessThan(orthogonal.nodes.find((node) => node.data.region === 'albion')!.position.x)
    const disconnected = await calculateTradeLayout(tradeNetwork.graphs.cross_region, 'cross_region', 'network')
    expect(disconnected.nodes).toHaveLength(tradeNetwork.graphs.cross_region.nodes.length)

    const hubId = selectTradeHub(cycleGraph)
    const hubs = await calculateTradeLayout(cycleGraph, 'cross_region', 'hubs')
    expect(hubs.nodes).toHaveLength(cycleGraph.nodes.length)
    expect(Object.keys(hubs.routes)).toHaveLength(cycleGraph.edges.length)
    expect(hubs.nodes.find((node) => node.id === hubId)?.data.layoutRole).toBe('hub')
    const focus = await calculateTradeLayout(cycleGraph, 'cross_region', 'focus', 'area-2')
    expect(focus.focusNodeId).toBe('area-2')
    expect(focus.nodes.find((node) => node.id === 'area-2')?.data.layoutRole).toBe('focus')
    expect(focus.nodes.find((node) => node.id === 'area-1')!.position.x).toBeLessThan(focus.nodes.find((node) => node.id === 'area-2')!.position.x)
    expect(focus.nodes.find((node) => node.id === 'area-3')!.position.x).toBeGreaterThan(focus.nodes.find((node) => node.id === 'area-2')!.position.x)

    installFetchMock()
    renderApp(<App />, '/trade')
    const focusButton = await screen.findByRole('button', { name: 'Focus' })
    await userEvent.click(focusButton)
    expect(focusButton).toHaveAttribute('aria-pressed', 'true')
    expect(await screen.findByLabelText('Focus city')).toBeInTheDocument()
    expect(localStorage.getItem('anno-companion:trade-network:campaign-1:latium:layout:v3')).toBe('focus')
  })

  it('keeps isolated cities visible without geographic coordinates or routes', async () => {
    installFetchMock()
    renderApp(<App />, '/areas')
    expect(await screen.findByText('Albion')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Cudslip/i })).toHaveAttribute('href', '/areas/3')
  })

  it('opens a persisted city from the regional list', async () => {
    installFetchMock()
    renderApp(<App />, '/areas/2')
    expect(await screen.findByRole('heading', { name: 'Naissus' }, { timeout: 5_000 })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: 'City stock planning' }, { timeout: 5_000 })).toBeInTheDocument()
    expect(await screen.findByRole('columnheader', { name: /Stock/i }, { timeout: 5_000 })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /Demand\/min/i })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /Supply\/min/i })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /Balance\/min/i })).toBeInTheDocument()
    expect(screen.queryByText('Goods and targets')).not.toBeInTheDocument()
  })

  it('labels a carried historical rate instead of leaving the resource learning', async () => {
    installFetchMock({
      '/api/v1/areas/2/stock-planning': {
        ...stockPlanning,
        area: { ...stockPlanning.area, area_pk: 2, area_name: 'Naissus' },
        groups: stockPlanning.groups.map((group) => ({
          ...group,
          items: group.items.map((item) => item.product_guid === '2174' ? {
            ...item,
            velocity_confidence: 'previous_session',
            velocity_is_historical: true,
          } : item),
        })),
      },
    })
    renderApp(<App />, '/areas/2?product=2174')
    expect(await screen.findByText(/Previous session/, {}, { timeout: 5_000 })).toBeInTheDocument()
    expect(screen.queryByText(/Learning/i)).not.toBeInTheDocument()
  })

  it('ranks deficits in a dense planning table and keeps one-resource history secondary', async () => {
    installFetchMock()
    renderApp(<App />, '/areas/1')
    expect(await screen.findByText(/10,768 population/, {}, { timeout: 5_000 })).toBeInTheDocument()
    const rows = screen.getAllByRole('row')
    expect(rows[1]).toHaveTextContent('Timber')
    expect(rows[1]).toHaveTextContent('−0.5')
    expect(rows[1]).toHaveTextContent('Observed stock -3.5/min')
    expect(screen.queryByRole('heading', { name: /history/i })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'View Timber stock history' }))
    expect(screen.getByText('Timber history')).toBeInTheDocument()
    expect(screen.getByText('Calculation evidence')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Sort by Resource' }))
    expect(screen.getAllByRole('row')[1]).toHaveTextContent('Bread')
  })

  it('makes stale telemetry explicit without turning observations into zero', async () => {
    installFetchMock({
      '/api/v1/dashboard/overview': { ...overview, meta: { ...overview.meta, is_stale: true, freshness_seconds: 180 } },
      '/api/v1/status': { ...((await import('./fixtures')).status), latest_snapshot: { ...overview.meta, is_stale: true, freshness_seconds: 180 } },
    })
    renderApp(<App />)
    expect(await screen.findByText('Telemetry is stale')).toBeInTheDocument()
    expect(screen.getByText(/nothing has been reset to zero/i)).toBeInTheDocument()
  })

  it('explains and saves a ranked route suggestion into the companion workflow', async () => {
    const fetchMock = installFetchMock()
    renderApp(<App />, '/trade')
    expect(await screen.findByRole('heading', { name: 'Turn shortages into route plans.' })).toBeInTheDocument()
    expect(screen.getAllByText(/route feasibility unknown/i).length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole('button', { name: /Explain plan/i }))
    expect(screen.getByText('What saving this plan means')).toBeInTheDocument()
    expect(screen.getByText(/Total movement/i)).toBeInTheDocument()
    expect(screen.getByText(/every slot holds at most 50t/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Save one-time plan/i }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost')
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      return url.pathname === '/api/v1/trade-plans' && method === 'POST'
    })).toBe(true))
  })

  it('recalculates recurring routes as rates and keeps ship sizing unknown without trip time', async () => {
    const recurringRoute = {
      ...trade.suggested_routes[0],
      suggestion_id: 'route:recurring_supply:1:2',
      plan_kind: 'recurring_supply' as const,
      quantity_unit: 'tons_per_minute' as const,
      reason: 'Recurring supply capped by current stable source growth.',
      evidence: { recommendation_id: 'route:recurring_supply:1:2', plan_kind: 'recurring_supply', recurring_safety_margin: .2 },
      goods: [{
        ...trade.suggested_routes[0].goods[0],
        advisory_amount: 3.2,
        quantity_unit: 'tons_per_minute' as const,
        source_velocity_confidence: 'stable',
        destination_velocity_confidence: 'stable',
        committed_export_rate_per_minute: 0,
        committed_import_rate_per_minute: 0,
        safety_margin_rate_per_minute: .8,
        projected_source_rate_per_minute: .8,
        projected_destination_rate_per_minute: -.3,
        projected_source_stock: null,
        projected_destination_stock: null,
      }],
    }
    installFetchMock({
      '/api/v1/trade/opportunities?plan_kind=recurring_supply': { ...trade, suggested_routes: [recurringRoute] },
    })
    renderApp(<App />, '/trade')
    await screen.findByRole('heading', { name: 'Turn shortages into route plans.' })
    await userEvent.selectOptions(screen.getByLabelText('Recommendation type'), 'recurring_supply')
    expect(await screen.findByText('3.2 t/min')).toBeInTheDocument()
    expect(screen.getAllByText('Recurring supply').length).toBeGreaterThan(1)
    expect(screen.getAllByText(/Ship count unknown/i).length).toBeGreaterThan(0)
    await userEvent.click(screen.getByRole('button', { name: /Explain plan/i }))
    expect(screen.getAllByText(/unknown until round-trip time is supplied/i).length).toBeGreaterThan(0)
    expect(screen.getByText(/\+4 t\/min observed/i)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Round trip for Juliana to Naissus'), '10')
    await userEvent.type(screen.getByLabelText('Ship cost for Juliana to Naissus'), '1000')
    expect(screen.getByText(/32t must move each 10-minute cycle/i)).toBeInTheDocument()
    expect(screen.getByText(/cost per supported t\/min: 312.5/i)).toBeInTheDocument()
  })

  it('opens a mapped trade edge with route, ship, and goods evidence', async () => {
    installFetchMock()
    renderApp(<App />, '/trade')
    expect(await screen.findByText('Trade network')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'List' }))
    await userEvent.click(screen.getByRole('button', { name: /Juliana.*Naissus/i }))
    expect(screen.getByRole('dialog', { name: /Trade evidence for Juliana to Naissus/i })).toBeInTheDocument()
    expect(screen.getAllByText('AC-7K2P Jul-Nai').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Mercury').length).toBeGreaterThan(0)
    expect(screen.getByText('Ship 8122')).toBeInTheDocument()
    expect(screen.getByText(/ID 8121/)).toBeInTheDocument()
    expect(screen.getByText(/Not exposed by validated telemetry/i)).toBeInTheDocument()
    expect(screen.getByText(/tested ship cargo binding returned invalid weak references/i)).toBeInTheDocument()
    expect(screen.getAllByText(/12 t\/min/i).length).toBeGreaterThan(0)
  })

  it('calculates a resource-first production chain and places capacity problems on their nodes', async () => {
    const layout = await calculateProductionLayout(productionExplorer)
    const bread = layout.nodes.find((node) => node.id === 'resource:2175')!
    const bakery = layout.nodes.find((node) => node.id === 'factory:bakery:2175')!
    const flour = layout.nodes.find((node) => node.id === 'resource:flour')!
    expect(bread.position.y).toBeLessThan(bakery.position.y)
    expect(bakery.position.y).toBeLessThan(flour.position.y)

    installFetchMock()
    renderApp(<App />, '/production?city=1')
    expect(await screen.findByRole('heading', { name: 'Build exactly what your city needs.' })).toBeInTheDocument()
    expect(screen.getByLabelText('Production region')).toHaveValue('Latium')
    expect(screen.getByLabelText('Production city')).toHaveValue('1')
    expect(screen.getByRole('combobox', { name: 'Resource' })).toHaveAttribute('placeholder', 'Bread')
    expect(await screen.findByText('Bakery')).toBeInTheDocument()
    expect(screen.getAllByText('Mill').length).toBeGreaterThan(0)
    expect(screen.getAllByText('1.1 req. · 2 built').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Capacity shortfall/i).length).toBeGreaterThan(0)
    expect(screen.queryByText('Stock-derived production view')).not.toBeInTheDocument()
    expect(screen.queryByText('Input pressure')).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText(/Bakery, 1.1 buildings required, 2 installed/i))
    expect(screen.getByRole('dialog', { name: 'Factory details for Bakery' })).toBeInTheDocument()
    expect(screen.getByText('Base recipe')).toBeInTheDocument()
    expect(screen.getByText(/catalog base cycles/i)).toBeInTheDocument()
  })

  it('groups the stock selector by producing region and workforce on city detail', async () => {
    const latium = stockPlanning.groups[0]
    const albion = {
      ...latium,
      key: 'Celtic:2192', label: 'Albion · Waders', region_id: 'Celtic', region_name: 'Albion',
      workforce_guid: '2192', population_guid: '1504', population_name: 'Waders', population: 850,
      items: [{ ...latium.items[0], product_guid: '2093', resource_name: 'Barley', stock: 17 }],
    }
    installFetchMock({
      '/api/v1/areas/1/stock-planning': { ...stockPlanning, groups: [latium, albion] },
    })
    renderApp(<App />, '/areas/1')
    expect(await screen.findByRole('heading', { name: 'Juliana' }, { timeout: 5_000 })).toBeInTheDocument()
    expect(screen.getByLabelText('Resource workforce')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Latium · Liberti · 2 goods' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Albion · Waders · 1 goods' })).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('Resource workforce'), 'Celtic:2192')
    expect(screen.getByText(/850 population/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View Barley stock history' })).toBeInTheDocument()
  })

  it('can assign the current authority epoch to an existing campaign', async () => {
    const campaigns = [
      ...(await import('./fixtures')).apiFixtures['/api/v1/campaigns'] as Array<Record<string, unknown>>,
      {
        campaign_id: 'campaign-2', display_name: 'Established campaign', game_seed: '952',
        participant_guid: '41', identity_method: 'user_assignment', identity_confidence: 'user_confirmed',
        created_at: new Date().toISOString(), archived_at: null,
      },
    ]
    const fetchMock = installFetchMock({ '/api/v1/campaigns': campaigns })
    renderApp(<App />, '/settings')
    const selector = await screen.findByLabelText('Assign current play session to campaign')
    await userEvent.selectOptions(selector, 'campaign-2')
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost')
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      return url.pathname === '/api/v1/campaigns' && method === 'PATCH'
    })).toBe(true))
  })
})
