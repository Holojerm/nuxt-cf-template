// The whole layer in a real browser: the page derives the keys with WebCrypto,
// Chromium's virtual authenticator answers the passkey ceremonies (with PRF),
// and a listener on `credentials:unlock` records what an app would be handed.
//
// One test, in order, because each step is the next one's precondition.

import AxeBuilder from '@axe-core/playwright'
import type { CDPSession, Page } from '@playwright/test'

import { expect, test, uniqueEmail } from '../../../../test/e2e/fixtures'

interface Unlock {
  reason: string
  userId: string
  unlockKey: string | null
  previousUnlockKey: string | null
  prfStatus: string | null
  prf: string | null
}

/**
 * Listen the way a fork's client plugin would. Lost on a full page load, so
 * each step that loads a page calls it again and reads the log before leaving.
 */
async function listen(page: Page): Promise<void> {
  await page.waitForFunction(() => Boolean(document.querySelector('#__nuxt')))
  await page.evaluate(() => {
    const root = document.querySelector('#__nuxt') as unknown as {
      __vue_app__: { $nuxt: { hook: (name: string, fn: (unlock: never) => void) => void } }
    }
    const hex = (bytes: Uint8Array | null | undefined) =>
      bytes ? [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('') : null
    const log: unknown[] = []
    ;(window as unknown as { unlocks: unknown[] }).unlocks = log
    root.__vue_app__.$nuxt.hook('credentials:unlock', (unlock) => {
      const u = unlock as {
        reason: string
        userId: string
        unlockKey: Uint8Array | null
        previousUnlockKey: Uint8Array | null
        passkey: { prf: Uint8Array | null; prfStatus: string } | null
      }
      log.push({
        reason: u.reason,
        userId: u.userId,
        unlockKey: hex(u.unlockKey),
        previousUnlockKey: hex(u.previousUnlockKey),
        prfStatus: u.passkey?.prfStatus ?? null,
        prf: hex(u.passkey?.prf),
      })
    })
  })
}

const unlocks = (page: Page) =>
  page.evaluate(() => (window as unknown as { unlocks: Unlock[] }).unlocks)

/**
 * The unlock a step produced, waited for. The hook's listeners run one after
 * another, and an app may have its own before this spec's (one that makes
 * keys, say), so the session can exist before ours has recorded anything.
 */
async function unlock(page: Page, reason: string): Promise<Unlock> {
  let found: Unlock | undefined
  await expect
    .poll(
      async () => {
        found = (await unlocks(page)).find((entry) => entry.reason === reason)
        return found?.reason
      },
      { timeout: 30_000 },
    )
    .toBe(reason)
  return found!
}

async function open(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'networkidle' })
  await listen(page)
}

/** The dev-only link the page shows when no mail provider is configured, as a local path. */
async function mailedLink(page: Page, name: string): Promise<string> {
  const href = await page.getByRole('link', { name }).getAttribute('href')
  const url = new URL(href!)
  return `${url.pathname}${url.hash}`
}

const sessionEmail = async (page: Page) => {
  const response = await page.context().request.get('/api/_auth/session')
  return ((await response.json()) as { user?: { email?: string } }).user?.email ?? null
}

async function signOut(page: Page): Promise<void> {
  await page.context().request.post('/api/auth/logout')
  expect(await sessionEmail(page)).toBeNull()
}

/** The button names the device's own unlock (Touch ID, Windows Hello…), which depends on the runner. */
const SIGN_IN_WITH_PASSKEY = /^Sign in with /

async function addVirtualAuthenticator(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  })
  return cdp
}

test('sign up by mail, sign in, passkey with PRF, change and reset the password', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const email = uniqueEmail('credentials')
  const first = 'first-password-0001'
  const second = 'second-password-0002'
  const third = 'third-password-0003'
  await addVirtualAuthenticator(page)

  // ── Sign up: an address first, the password on the page the mail opens ─────
  await open(page, '/auth/sign-up')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a link' }).click()
  await expect(page.getByText('Check your inbox')).toBeVisible({ timeout: 30_000 })
  expect(await sessionEmail(page)).toBeNull()

  await open(page, await mailedLink(page, 'Open the confirmation link'))
  // This browser can make a passkey, so that is offered first.
  await page.getByRole('button', { name: 'Use a password instead' }).click()
  await page.getByLabel('Password').fill(first)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect.poll(() => sessionEmail(page), { timeout: 30_000 }).toBe(email)
  const signedUp = await unlock(page, 'sign-up')
  expect(signedUp).toMatchObject({ reason: 'sign-up', prfStatus: null })
  expect(signedUp.unlockKey).toMatch(/^[0-9a-f]{64}$/)

  // ── Password sign-in hands over an unlock key; a wrong password does not ───
  await signOut(page)
  await open(page, '/auth/sign-in')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('not-the-password')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByText('Wrong email or password.')).toBeVisible({ timeout: 30_000 })
  expect(await unlocks(page)).toEqual([])

  await page.getByLabel('Password').fill(first)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect.poll(() => sessionEmail(page), { timeout: 30_000 }).toBe(email)
  const signedIn = await unlock(page, 'sign-in')
  expect(signedIn).toMatchObject({ reason: 'sign-in', prfStatus: null })
  // The same password derives the same key on every sign-in: the salt is the account's.
  expect(signedIn.unlockKey).toBe(signedUp.unlockKey)
  const firstKey = signedIn.unlockKey

  // ── The security page: axe, add a passkey, PRF arrives ─────────────────────
  await open(page, '/settings/security')
  await expect(page.getByRole('heading', { name: 'Passkeys' })).toBeVisible()
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze()
  expect(violations.map((violation) => `${violation.id}: ${violation.help}`)).toEqual([])

  await page.getByLabel('Name for the new passkey').fill('Virtual key')
  await page.getByRole('button', { name: 'Add a passkey' }).click()
  await expect(page.getByText('Virtual key')).toBeVisible({ timeout: 30_000 })
  const registered = await unlock(page, 'passkey-register')
  expect(registered).toMatchObject({
    reason: 'passkey-register',
    prfStatus: 'provided',
    unlockKey: null,
  })
  expect(registered.prf).toMatch(/^[0-9a-f]{64}$/)

  // ── Changing the password needs the current one, and hands over both keys ──
  await page.getByLabel('Current password').fill('not-the-password')
  await page.getByLabel('New password').fill(second)
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText("That isn't your current password.")).toBeVisible({ timeout: 30_000 })

  await page.getByLabel('Current password').fill(first)
  await page.getByRole('button', { name: 'Change password' }).click()
  await expect(page.getByText('Password changed').first()).toBeVisible({ timeout: 30_000 })
  const changed = await unlock(page, 'password-change')
  expect(changed.previousUnlockKey).toBe(firstKey)
  expect(changed.unlockKey).toMatch(/^[0-9a-f]{64}$/)
  expect(changed.unlockKey).not.toBe(firstKey)
  // The session that changed it survived its own revocation.
  expect(await sessionEmail(page)).toBe(email)

  // ── Passkey sign-in: no password, the same PRF secret as at registration ───
  await signOut(page)
  await open(page, '/auth/sign-in')
  await page.getByRole('button', { name: SIGN_IN_WITH_PASSKEY }).click()
  await expect.poll(() => sessionEmail(page), { timeout: 30_000 }).toBe(email)
  const viaPasskey = await unlock(page, 'passkey-sign-in')
  expect(viaPasskey).toMatchObject({
    reason: 'passkey-sign-in',
    prfStatus: 'provided',
    prf: registered.prf,
    unlockKey: null,
  })

  // ── Reset by mail: a new key, no old one, and the old password is dead ─────
  await signOut(page)
  await open(page, '/auth/reset')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a reset link' }).click()
  await expect(page.getByText('Check your inbox')).toBeVisible({ timeout: 30_000 })

  await open(page, await mailedLink(page, 'Open the reset link'))
  await page.getByLabel('New password').fill(third)
  await page.getByRole('button', { name: 'Set new password' }).click()
  await expect.poll(() => sessionEmail(page), { timeout: 30_000 }).toBe(email)
  const reset = await unlock(page, 'password-reset')
  expect(reset).toMatchObject({ reason: 'password-reset', previousUnlockKey: null })
  expect(reset.unlockKey).not.toBe(changed.unlockKey)

  await signOut(page)
  await open(page, '/auth/sign-in')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(second)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByText('Wrong email or password.')).toBeVisible({ timeout: 30_000 })
})

test('sign up with a passkey and no password, then add one from the security page', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const email = uniqueEmail('passkey-first')
  const password = 'later-password-0004'
  await addVirtualAuthenticator(page)

  await open(page, '/auth/sign-up')
  await page.getByLabel('Email').fill(email)
  await page.getByRole('button', { name: 'Email me a link' }).click()
  await expect(page.getByText('Check your inbox')).toBeVisible({ timeout: 30_000 })

  await open(page, await mailedLink(page, 'Open the confirmation link'))
  await page.getByRole('button', { name: /^Continue with / }).click()
  await expect.poll(() => sessionEmail(page), { timeout: 30_000 }).toBe(email)
  const signedUp = await unlock(page, 'sign-up')
  expect(signedUp).toMatchObject({ reason: 'sign-up', unlockKey: null, prfStatus: 'provided' })
  expect(signedUp.prf).toMatch(/^[0-9a-f]{64}$/)

  // No password yet: the security page sets the first one without asking for another.
  await open(page, '/settings/security')
  await expect(page.getByText('This account has no password yet.')).toBeVisible()
  await page.getByLabel('New password').fill(password)
  await page.getByRole('button', { name: 'Set a password' }).click()
  const set = await unlock(page, 'password-set')
  expect(set.unlockKey).toMatch(/^[0-9a-f]{64}$/)
  await expect(page.getByLabel('Current password')).toBeVisible()

  // The passkey and the password both sign in now.
  await signOut(page)
  await open(page, '/auth/sign-in')
  await page.getByRole('button', { name: SIGN_IN_WITH_PASSKEY }).click()
  await expect.poll(() => sessionEmail(page), { timeout: 30_000 }).toBe(email)
  expect((await unlock(page, 'passkey-sign-in')).prf).toBe(signedUp.prf)

  await signOut(page)
  await open(page, '/auth/sign-in')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect.poll(() => sessionEmail(page), { timeout: 30_000 }).toBe(email)
  expect((await unlock(page, 'sign-in')).unlockKey).toBe(set.unlockKey)
})
