// The worker in a real browser: it registers, takes control, and answers a
// navigation with the offline page once the network is cut.

import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// Every other suite runs with service workers blocked (playwright.config.ts).
test.use({ serviceWorkers: 'allow' })

test('a navigation with no network shows the offline page, and its link retries', async ({
  page,
  context,
}) => {
  await page.goto('/terms')
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)

  await context.setOffline(true)
  await page.goto('/privacy')
  await expect(page.getByRole('heading', { name: 'You are offline' })).toBeVisible()
  expect(new URL(page.url()).pathname).toBe('/privacy')

  await context.setOffline(false)
  await page.getByRole('link', { name: 'Try again' }).click()
  await expect(page.getByRole('heading', { name: 'You are offline' })).toHaveCount(0)
  await expect(page.locator('#__nuxt')).toBeAttached()
  expect(new URL(page.url()).pathname).toBe('/privacy')
})

// Here and not in test/a11y: that sweep waits for NuxtUI's `dark` class, and
// this document is not a Nuxt page. It has one palette, so one scan.
test('the offline page passes axe and fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  const response = await page.goto('/offline')
  expect(response?.status()).toBe(200)

  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  expect(violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([])

  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(scrollWidth).toBe(clientWidth)
})

test('an error from the server is not mistaken for being offline', async ({ page }) => {
  await page.goto('/terms')
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)

  const response = await page.goto('/no-such-page')
  expect(response?.status()).toBe(404)
  await expect(page.getByRole('heading', { name: 'You are offline' })).toHaveCount(0)
})
