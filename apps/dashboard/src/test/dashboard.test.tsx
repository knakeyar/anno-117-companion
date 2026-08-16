import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../App'
import { calculateTradeLayout, selectTradeHub } from '../components/tradeNetworkLayout'
import { inventory, overview, tradeNetwork } from './fixtures'
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
    renderApp(<App />, '/areas')
    await userEvent.click(await screen.findByRole('link', { name: /Naissus/i }))
    expect(await screen.findByRole('heading', { name: 'Naissus' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Stock history by workforce' })).toBeInTheDocument()
  })

  it('labels a carried historical rate instead of leaving the resource learning', async () => {
    installFetchMock({
      '/api/v1/inventory/latest': {
        ...inventory,
        items: inventory.items.map((item) => item.area_pk === 2 ? {
          ...item,
          velocity: {
            ...item.velocity!, confidence: 'previous_session' as const,
            source_confidence: 'stable' as const, is_historical: true,
          },
        } : item),
      },
    })
    renderApp(<App />, '/areas/2')
    expect(await screen.findByText('Previous session')).toBeInTheDocument()
    expect(screen.queryByText(/Learning/i)).not.toBeInTheDocument()
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
    expect(screen.getByText(/Capacity loads/i)).toBeInTheDocument()
    expect(screen.getByText(/planning assumption only/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Save plan/i }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost')
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      return url.pathname === '/api/v1/trade-plans' && method === 'POST'
    })).toBe(true))
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
    expect(screen.getByText(/12 target/i)).toBeInTheDocument()
  })

  it('shows factory presence and pressure by city', async () => {
    installFetchMock({ '/api/v1/inventory/latest': inventory })
    renderApp(<App />, '/production')
    expect(await screen.findByRole('heading', { name: 'Manage each city by chain.' })).toBeInTheDocument()
    expect(screen.getAllByText('Juliana').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/installed/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Net stock change/).length).toBeGreaterThan(0)
    expect(document.querySelector('.presence-dot.healthy')).toBeInTheDocument()
  })

  it('groups the stock selector by producing region and workforce on city detail', async () => {
    const fixtures = await import('./fixtures')
    const chainResponse = fixtures.apiFixtures['/api/v1/production/chains'] as { chains: Array<Record<string, unknown>> }
    const foreignGood = {
      ...inventory.items[0],
      product_guid: '2093',
      product_name: 'Barley',
      stock: 17,
      available_stock: 17,
    }
    const albionChain = {
      ...chainResponse.chains[0],
      recipe_id: 'factory:2799',
      name: 'Barley Farm',
      building_guid: '2799',
      building_name: 'Barley Farm',
      workforce_guid: '2192',
      workforce_name: 'Wader Workforce',
      associated_regions: ['Celtic'],
      items: [{ role: 'output', ordinal: 1, product_guid: '2093', product_name: 'Barley', amount: 1 }],
    }
    installFetchMock({
      '/api/v1/inventory/latest': { ...inventory, items: [...inventory.items, foreignGood] },
      '/api/v1/production/chains': { ...chainResponse, chains: [...chainResponse.chains, albionChain] },
    })
    renderApp(<App />, '/areas/1')
    expect(await screen.findByRole('heading', { name: 'Juliana' })).toBeInTheDocument()
    expect(screen.getByLabelText('Resource workforce')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Latium · Libertus Workforce · 1 goods' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Albion · Wader Workforce · 1 goods' })).toBeInTheDocument()
    expect(screen.getByText('Construction materials')).toBeInTheDocument()
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
