// Spec — sign out everywhere.
//
// Two browser contexts hold the same session cookie (the fixture caches the
// dev sign-in per address). One clicks "Sign out everywhere" on /account; the
// route moves the account's watermark and re-issues that context's cookie, so
// it stays signed in while the other context's next /api request is refused
// with a 401 by server/middleware/auth.ts.

import { expect, test, uniqueEmail, watchForViolations } from './fixtures'

test('revoking from one device signs the other out, and only the other', async ({ signInAs }) => {
  const email = uniqueEmail('sign-out-everywhere')
  const laptop = await signInAs(email, 'Two Devices')
  const phone = await signInAs(email, 'Two Devices')
  const violations = watchForViolations(laptop.page)

  // Both cookies are accepted before anything happens.
  expect((await phone.context.request.get('/api/_auth/session')).ok()).toBe(true)

  // `networkidle`, because the click must land AFTER hydration: on a cold dev
  // compile the button is in the DOM seconds before its handler is, and a
  // click in that gap is silently lost.
  await laptop.page.goto('/account', { waitUntil: 'networkidle' })
  await laptop.page.getByRole('button', { name: 'Sign out everywhere' }).click()
  await expect(laptop.page.getByText('Signed out everywhere else')).toBeVisible({ timeout: 10_000 })

  // The device that clicked keeps its (re-issued) session…
  const mine = await laptop.context.request.get('/api/_auth/session')
  expect(mine.ok()).toBe(true)
  expect(((await mine.json()) as { user?: { email?: string } }).user?.email).toBe(email)

  // …and the other one is refused on its next request.
  const theirs = await phone.context.request.get('/api/_auth/session')
  expect(theirs.status()).toBe(401)

  await violations.assertClean()
})
