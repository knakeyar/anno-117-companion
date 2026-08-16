import { expect, test } from '@playwright/test'
import { apiFixtures, overview } from '../src/test/fixtures'

let overviewRequests = 0
let acceptedPlans = 0

test.beforeEach(async ({ page }) => {
  overviewRequests = 0
  acceptedPlans = 0
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
      await route.fulfill({ json: { trade_plan_id: 'plan-1', campaign_id: body.campaign_id, source_area_pk: body.source_area_pk, source_area_name: 'Juliana', destination_area_pk: body.destination_area_pk, destination_area_name: 'Naissus', status: 'planned', reason: body.reason, evidence: body.evidence, goods: body.goods.map((item: { product_guid: string; amount: number }) => ({ ...item, product_name: 'Timber' })), created_at: new Date().toISOString(), updated_at: new Date().toISOString() } })
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
  await expect(page.getByText('Route feasibility unknown').first()).toBeVisible()
  await page.getByRole('button', { name: 'Accept plan' }).click()
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
