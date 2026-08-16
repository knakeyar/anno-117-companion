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
    if (url.pathname === '/api/v1/inventory/history') {
      return Response.json({ items: [] })
    }
    const fixture = fixtures[url.pathname]
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
