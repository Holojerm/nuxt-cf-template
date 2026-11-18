// The worker in a real browser: it registers, takes control, answers a
// navigation with the offline page once the network is cut, and turns a push
// into a notification.

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

// The push is handed to the worker by the browser itself (DevTools' "Push"
// button, over CDP), so this is the served script's own handler reading a real
// PushEvent. Headless Chromium refuses to show any notification ("denied",
// whatever a context is granted), so `showNotification` is recorded in place:
// what reaches the screen, and the push service before it, need a real device.
test('a push reaches the worker and asks for a notification with its message', async ({
  page,
  context,
}) => {
  await page.goto('/terms')
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
  const origin = new URL(page.url()).origin

  const worker = context.serviceWorkers()[0]!
  await worker.evaluate(() => {
    const scope = self as unknown as {
      shown: unknown[]
      registration: { showNotification: (...shown: unknown[]) => Promise<void> }
    }
    scope.shown = []
    scope.registration.showNotification = async (...shown) => void scope.shown.push(shown)
  })

  const cdp = await context.newCDPSession(page)
  const registered = new Promise<string>((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
      const mine = registrations.find((entry) => entry.scopeURL.startsWith(origin))
      if (mine) resolve(mine.registrationId)
    })
  })
  await cdp.send('ServiceWorker.enable')
  await cdp.send('ServiceWorker.deliverPushMessage', {
    origin,
    registrationId: await registered,
    data: JSON.stringify({ title: 'The post is in', body: 'One letter.', url: '/privacy' }),
  })

  await expect
    .poll(() => worker.evaluate(() => (self as unknown as { shown: unknown[] }).shown))
    .toEqual([
      [
        'The post is in',
        {
          body: 'One letter.',
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          data: { url: '/privacy' },
        },
      ],
    ])
})
