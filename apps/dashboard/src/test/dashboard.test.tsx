import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../App'
import { inventory, overview } from './fixtures'
import { installFetchMock, renderApp } from './render'

describe('first-class management dashboard', () => {
  it('shows actionable command-center evidence and honest scope language', async () => {
    installFetchMock()
    renderApp(<App />)
    expect(await screen.findByRole('heading', { name: 'Keep every island moving.' })).toBeInTheDocument()
    expect(screen.getByText('Stock is below the management target')).toBeInTheDocument()
    expect(screen.getByText('Route feasibility unknown')).toBeInTheDocument()
    expect(screen.getByText(/Current-area workforce/i)).toBeInTheDocument()
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

  it('supports filtering trade observations and opening a policy editor', async () => {
    installFetchMock()
    renderApp(<App />, '/trade')
    expect(await screen.findByRole('heading', { name: 'Balance stock across the empire.' })).toBeInTheDocument()
    const search = screen.getByPlaceholderText('Search goods or islands')
    await userEvent.type(search, 'Naissus')
    expect(screen.getAllByText('Naissus').length).toBeGreaterThan(0)
    expect(screen.queryByRole('link', { name: 'Juliana' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /Edit Timber policy for Naissus/ }))
    expect(screen.getByRole('dialog', { name: /Timber in Naissus/ })).toBeInTheDocument()
    expect(screen.getByText(/do not change the game/i)).toBeInTheDocument()
  })

  it('keeps the production page useful when recipe coverage is incomplete', async () => {
    installFetchMock({ '/api/v1/inventory/latest': inventory })
    renderApp(<App />, '/production')
    expect(await screen.findByRole('heading', { name: 'Read the pressure, not a fictional rate.' })).toBeInTheDocument()
    expect(screen.getByText('Recipe catalog awaiting verified data')).toBeInTheDocument()
    expect(screen.getAllByText(/Net stock change/).length).toBeGreaterThan(0)
    expect(screen.getByText(/UI-selected statistics are deliberately excluded/i)).toBeInTheDocument()
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
