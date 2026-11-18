// The settings page in a real browser, signed in: the install prompt, the
// notifications switch against the real routes, and what iOS is told.
//
// Chromium here has no push service to subscribe with (Playwright's contexts
// are incognito-like), so `PushManager.subscribe` is replaced: it hands back a
// subscription shaped like a real one. Everything after it is real: the
// composable, the routes, the row in D1. A push
// reaching the worker is pwa.spec.ts; one reaching a device is not tested here.

import { webcrypto } from 'node:crypto'

import AxeBuilder from '@axe-core/playwright'
import type { BrowserContext, Page } from '@playwright/test'

import { expect, test, uniqueEmail, watchForViolations } from '../../../../test/e2e/fixtures'

const base64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')

/** A subscription as a browser would report it, with keys of the right shape. */
async function fakeSubscription(name: string) {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])
  const point = new Uint8Array(await webcrypto.subtle.exportKey('raw', pair.publicKey))
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${uniqueEmail(name).replace(/\W/g, '-')}`,
    keys: {
      p256dh: base64Url(point),
      auth: base64Url(webcrypto.getRandomValues(new Uint8Array(16))),
    },
  }
}

/** Stand in for the browser's push service. Survives a reload, as a real subscription does. */
async function stubPushService(
  page: Page,
  subscription: Awaited<ReturnType<typeof fakeSubscription>>,
) {
  await page.addInitScript((json) => {
    const KEY = 'e2e-push-subscription'
    const fake = {
      endpoint: json.endpoint,
      toJSON: () => json,
      unsubscribe: async () => {
        sessionStorage.removeItem(KEY)
        return true
      },
    }
    PushManager.prototype.subscribe = async function () {
      sessionStorage.setItem(KEY, '1')
      return fake as unknown as PushSubscription
    }
    PushManager.prototype.getSubscription = async function () {
      return sessionStorage.getItem(KEY) ? (fake as unknown as PushSubscription) : null
    }
  }, subscription)
}

const settings = (page: Page) => page.getByTestId('pwa-device-settings')
const notifications = (page: Page) =>
  page.getByRole('switch', { name: 'Notifications on this device' })

async function openSettings(page: Page): Promise<void> {
  // `networkidle`: the card renders after mount, and a click before hydration is lost.
  await page.goto('/settings/device', { waitUntil: 'networkidle' })
  await expect(settings(page)).toBeVisible()
}

async function expectAccessible(page: Page): Promise<void> {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  expect(
    violations.map(
      (violation) => `${violation.id}: ${violation.nodes.map((node) => node.html).join(' | ')}`,
    ),
  ).toEqual([])
}

/**
 * Should the browser make an install offer of its own, it is swallowed before
 * the app sees it, so the only offer is the one a test makes.
 */
async function withoutBrowserInstallOffer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.addEventListener(
      'beforeinstallprompt',
      (event) => {
        if (event.isTrusted) event.stopImmediatePropagation()
      },
      true,
    )
  })
}

test.use({ serviceWorkers: 'allow' })

// One account for the whole file, and one worker, so the file costs two dev
// sign-ins. Every local request shares one address and the /api/auth/ surface
// allows 30 a minute: a sign-in per test here was enough to get another
// layer's spec refused. Tests stay apart by using their own endpoints.
test.describe.configure({ mode: 'default' })
const EMAIL = uniqueEmail('device')
const NAME = 'Ada'

test.describe('with notifications allowed', () => {
  // Headless Chromium answers "denied" whatever a context is granted, so the
  // browser's answer is the second thing replaced here.
  const allowed = async (signedIn: { context: BrowserContext; page: Page }) => {
    await signedIn.page.addInitScript(() => {
      Object.defineProperty(Notification, 'permission', { get: () => 'granted' })
      Notification.requestPermission = async () => 'granted'
    })
    await withoutBrowserInstallOffer(signedIn.page)
    return signedIn
  }

  test('notifications are off until turned on, and turning them off forgets the browser', async ({
    signInAs,
  }) => {
    const { page, context } = await allowed(await signInAs(EMAIL, NAME))
    const violations = watchForViolations(page)
    const subscription = await fakeSubscription('push-switch')
    await stubPushService(page, subscription)
    const stored = async () =>
      (await (
        await context.request.post('/api/pwa/push/status', {
          data: { endpoint: subscription.endpoint },
        })
      ).json()) as { subscribed: boolean }

    await openSettings(page)
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
    await expect(notifications(page)).not.toBeChecked()
    expect(await stored()).toEqual({ subscribed: false })

    await notifications(page).click()
    await expect(notifications(page)).toBeChecked()
    expect(await stored()).toEqual({ subscribed: true })

    // Still on after a reload: the page asks the server, it does not remember.
    await openSettings(page)
    await expect(notifications(page)).toBeChecked()

    await notifications(page).click()
    await expect(notifications(page)).not.toBeChecked()
    expect(await stored()).toEqual({ subscribed: false })

    await violations.assertClean()
  })

  test('a browser the last person subscribed in shows off for the next one', async ({
    signInAs,
  }) => {
    const subscription = await fakeSubscription('push-shared')
    const first = await allowed(await signInAs(EMAIL, NAME))
    await stubPushService(first.page, subscription)
    await openSettings(first.page)
    await first.page.waitForFunction(() => navigator.serviceWorker.controller !== null)
    await notifications(first.page).click()
    await expect(notifications(first.page)).toBeChecked()

    // The same browser subscription, now under another account's session.
    const second = await allowed(await signInAs(uniqueEmail('push-shared-b'), 'Second'))
    await stubPushService(second.page, subscription)
    await second.page.addInitScript(() => sessionStorage.setItem('e2e-push-subscription', '1'))
    await openSettings(second.page)
    await expect(notifications(second.page)).not.toBeChecked()
  })

  test('the install button shows the browser’s prompt once, when the browser offers one', async ({
    signInAs,
  }) => {
    const { page } = await allowed(await signInAs(EMAIL, NAME))
    await openSettings(page)
    const install = page.getByRole('button', { name: 'Install', exact: true })
    await expect(install).toHaveCount(0)

    // What Chrome fires once the app is installable.
    await page.evaluate(() => {
      const offer = Object.assign(new Event('beforeinstallprompt'), {
        prompt: async () => {
          ;(window as unknown as { prompted: number }).prompted = 1
        },
        userChoice: Promise.resolve({ outcome: 'accepted' }),
      })
      window.dispatchEvent(offer)
    })
    await expect(install).toBeVisible()

    await install.click()
    await expect(install).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { prompted: number }).prompted)).toBe(1)
  })

  test('the page passes axe and fits a phone', async ({ signInAs }) => {
    const { page } = await allowed(await signInAs(EMAIL, NAME))
    await page.setViewportSize({ width: 375, height: 812 })
    await openSettings(page)
    await expect(notifications(page)).toBeEnabled()
    await expectAccessible(page)

    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    expect(scrollWidth).toBe(clientWidth)
  })
})

test.describe('with notifications blocked', () => {
  test('the switch stays off and says where to allow them, legibly', async ({ signInAs }) => {
    const { page } = await signInAs(EMAIL, NAME)
    await page.addInitScript(() => {
      Object.defineProperty(Notification, 'permission', { get: () => 'denied' })
    })
    await openSettings(page)
    await expect(notifications(page)).toBeDisabled()
    await expect(notifications(page)).not.toBeChecked()
    await expect(page.getByText('blocked in your browser')).toBeVisible()
    // A disabled control is where contrast usually goes missing.
    await expectAccessible(page)
  })
})

test.describe('on an iPhone, in a browser tab', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  })

  test('says how to add the app to the Home Screen, and that notifications wait for it', async ({
    signInAs,
  }) => {
    const { page } = await signInAs(EMAIL, NAME)
    // Safari has no PushManager until the app runs from the Home Screen.
    await page.addInitScript(() => {
      delete (window as unknown as { PushManager?: unknown }).PushManager
    })
    await openSettings(page)

    await expect(page.getByText('Tap Share in your browser')).toBeVisible()
    await expect(page.getByText('once the app is on your Home Screen')).toBeVisible()
    await expect(notifications(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Install', exact: true })).toHaveCount(0)
  })
})
