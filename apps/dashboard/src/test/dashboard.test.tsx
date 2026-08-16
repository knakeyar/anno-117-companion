import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../App'
import { inventory, overview } from './fixtures'
import { installFetchMock, renderApp } from './render'

describe('first-class management dashboard', () => {
  it('shows actionable command-center evidence and honest scope language', async () => {
    installFetchMock()
    renderApp(<App />)
    expect(await screen.findByRole('heading', { name: 'Decide what to fix next.' })).toBeInTheDocument()
    expect(screen.getByText('Move Timber from observed surplus.')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: /Latium city map/i })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Ask advisor/i }).length).toBeGreaterThan(0)
    expect(screen.queryByText(/measured production rate/i)).not.toBeInTheDocument()
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

  it('accepts a ranked route suggestion into the companion workflow', async () => {
    const fetchMock = installFetchMock()
    renderApp(<App />, '/trade')
    expect(await screen.findByRole('heading', { name: 'Turn shortages into route plans.' })).toBeInTheDocument()
    expect(screen.getByText(/route feasibility unknown/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Accept plan/i }))
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://localhost')
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      return url.pathname === '/api/v1/trade-plans' && method === 'POST'
    })).toBe(true))
  })

  it('shows factory presence and pressure by city', async () => {
    installFetchMock({ '/api/v1/inventory/latest': inventory })
    renderApp(<App />, '/production')
    expect(await screen.findByRole('heading', { name: 'Manage each city by chain.' })).toBeInTheDocument()
    expect(screen.getAllByText('Juliana').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/installed/i).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Net stock change/).length).toBeGreaterThan(0)
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
