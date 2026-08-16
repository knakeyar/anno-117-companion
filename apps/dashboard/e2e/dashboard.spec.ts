import { expect, test } from '@playwright/test'
import { apiFixtures } from '../src/test/fixtures'

let overviewRequests = 0

test.beforeEach(async ({ page }) => {
  overviewRequests = 0
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
  await expect(page.getByRole('heading', { name: 'Keep every island moving.' })).toBeVisible()
  await expect(page.getByText('Stock is below the management target')).toBeVisible()
  await page.getByRole('link', { name: 'Trade', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Balance stock across the empire.' })).toBeVisible()
  await expect(page.getByText('Route feasibility unknown').first()).toBeVisible()
  await page.getByRole('button', { name: 'Edit Timber policy for Naissus' }).click()
  await page.getByLabel('Low target').fill('20')
  await page.getByLabel('High target').fill('70')
  await page.getByRole('button', { name: 'Save policy' }).click()
  await expect(page.getByRole('dialog')).toBeHidden()
})

test('production coverage and health remain transparent', async ({ page }) => {
  await page.goto('/production')
  await expect(page.getByText('Recipe catalog awaiting verified data')).toBeVisible()
  await page.getByRole('link', { name: 'Health', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Know exactly what the dashboard knows.' })).toBeVisible()
  await expect(page.getByText('/data/anno-companion.sqlite3')).toBeVisible()
})

test('live events refresh data and navigation fits the viewport', async ({ page }, testInfo) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Keep every island moving.' })).toBeVisible()
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
