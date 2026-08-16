import { expect, test } from '@playwright/test'
import { apiFixtures, overview } from '../src/test/fixtures'

let overviewRequests = 0
let acceptedPlans = 0
let linkedRoutes = 0

test.beforeEach(async ({ page }) => {
  overviewRequests = 0
  acceptedPlans = 0
  linkedRoutes = 0
  await page.addInitScript(() => {
    class TestEventSource extends EventTarget {
      constructor(_url: string) {
        super()
        setTimeout(() => this.dispatchEvent(new MessageEvent('snapshot_completed', { data: '{"snapshot_id":45}' })), 1_000)
      }
      close() {}
    }
    Object.defineProperty(window, 'EventSource', { value: TestEventSource, writable: true })
  })
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/v1/dashboard/overview') overviewRequests += 1
    if (url.pathname === '/api/v1/policies' && route.request().method() === 'PUT') {
      await route.fulfill({ json: route.request().postDataJSON() })
      return
    }
    if (url.pathname === '/api/v1/trade-plans' && route.request().method() === 'POST') {
      acceptedPlans += 1
      const body = route.request().postDataJSON()
      await route.fulfill({ json: { trade_plan_id: 'plan-new', campaign_id: body.campaign_id, source_area_pk: body.source_area_pk, source_area_name: 'Juliana', destination_area_pk: body.destination_area_pk, destination_area_name: 'Naissus', status: 'planned', plan_kind: body.plan_kind, route_tag: 'AC-NEW1', suggested_route_name: 'AC-NEW1 JUL-NAI', usable_ship_capacity: null, expected_round_trip_minutes: null, estimated_required_ships: null, runtime_status: 'not_detected', runtime_freshness: 'historical', goods_verification: 'planned_only', last_runtime_match_at: null, reason: body.reason, evidence: body.evidence, goods: body.goods.map((item: { product_guid: string; amount: number }) => ({ ...item, product_name: 'Timber' })), created_at: new Date().toISOString(), updated_at: new Date().toISOString() } })
      return
    }
    if (url.pathname === '/api/v1/trade/route-links' && route.request().method() === 'POST') {
      linkedRoutes += 1
      const body = route.request().postDataJSON()
      await route.fulfill({ json: { link_id: 'link-new', ...body, route_name: 'Bread Cud - Rhy', ship_ids: ['8121'], trade_plan_id: body.trade_plan_id ?? null, source_area_name: 'Juliana', destination_area_name: 'Cudslip', link_method: 'manual', first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() } })
      return
    }
    if (url.pathname.startsWith('/api/v1/actions/') && route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON()
      await route.fulfill({ json: { ...overview.actions[0], status: body.status } })
      return
    }
    if (url.pathname === '/api/v1/inventory/history') {
      await route.fulfill({ json: { items: [] } })
      return
    }
    const fixture = apiFixtures[url.pathname]
    await route.fulfill(fixture === undefined ? { status: 404, body: 'Not found' } : { json: fixture })
  })
})

test('command center and trade workflow stay actionable', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Decide what to fix next.' })).toBeVisible()
  await expect(page.getByText('Estimated base factory maintenance')).toBeVisible()
  await page.getByRole('main').getByRole('button', { name: 'Ask advisor' }).click()
  await expect(page.getByRole('complementary', { name: 'Economic advisor' })).toBeVisible()
  await page.getByRole('button', { name: 'Close advisor' }).click()
  await page.getByRole('link', { name: 'Trade', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Turn shortages into route plans.' })).toBeVisible()
  await page.getByRole('button', { name: 'List' }).click()
  await page.getByRole('button', { name: /Juliana.*Naissus/i }).click()
  await expect(page.getByRole('dialog', { name: /Trade evidence for Juliana to Naissus/i })).toBeVisible()
  await expect(page.getByText('Mercury').last()).toBeVisible()
  await expect(page.getByText('Timber').last()).toBeVisible()
  await page.getByRole('button', { name: 'Close evidence' }).click()
  await page.getByRole('button', { name: 'Link route' }).click()
  await page.getByLabel('Source').selectOption('1')
  await page.getByLabel('Destination').selectOption('3')
  await page.getByRole('button', { name: 'Save link' }).click()
  await expect.poll(() => linkedRoutes).toBe(1)
  await expect(page.getByText('Route feasibility unknown').first()).toBeVisible()
  await page.getByRole('button', { name: 'Save plan' }).click()
  await expect.poll(() => acceptedPlans).toBe(1)
})

test('production coverage and health remain transparent', async ({ page }) => {
  await page.goto('/production')
  await expect(page.getByRole('heading', { name: 'Manage each city by chain.' })).toBeVisible()
  await expect(page.getByText('Fishing Hut').first()).toBeVisible()
  await page.getByRole('link', { name: 'Health', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Know exactly what the dashboard knows.' })).toBeVisible()
  await expect(page.getByText('/data/anno-companion.sqlite3')).toBeVisible()
})

test('regional city list opens the persisted area detail view', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.goto('/areas')
  await expect(page.getByRole('heading', { name: 'Choose a city to manage.' })).toBeVisible()
  await page.locator('.area-list-row').filter({ hasText: 'Juliana' }).click()
  await expect(page).toHaveURL(/\/areas\/1$/)
  await expect(page.getByRole('heading', { name: 'Juliana' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Stock history by workforce' })).toBeVisible()
  expect(pageErrors).toEqual([])
})

test('live events refresh data and navigation fits the viewport', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Decide what to fix next.' })).toBeVisible()
  await expect.poll(() => overviewRequests).toBeGreaterThan(1)
  if (testInfo.project.name === 'mobile') {
    await expect(page.locator('.mobile-nav')).toBeVisible()
    await expect(page.locator('.sidebar')).toBeHidden()
  } else {
    await expect(page.locator('.sidebar')).toBeVisible()
    await expect(page.locator('.mobile-nav')).toBeHidden()
  }
  await page.keyboard.press('Tab')
  await expect(page.locator(':focus')).toBeVisible()
})
