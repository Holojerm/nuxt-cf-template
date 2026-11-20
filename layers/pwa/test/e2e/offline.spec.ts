// Offline routes and the outbox in a real browser, signed in, against the
// dev-only example page (app/pages/pwa-example.vue), which e2e.config.ts names
// as an offline route: the page opens with the network cut, a write made there
// is kept and sent once, and none of it is there for the next account.

import type { BrowserContext, Page } from '@playwright/test'

import { expect, test as base, uniqueEmail } from '../../../../test/e2e/fixtures'

interface SignedIn {
  id: string
  email: string
}

/**
 * Three accounts for the whole file, each signed in once, and the tests in
 * order in one worker: a sign-in per test was enough to get refused by the
 * sign-in limits. So nothing may assume an account's notes start empty: each
 * test writes a note of its own.
 */
const ACCOUNTS = {
  main: uniqueEmail('offline-main'),
  ada: uniqueEmail('offline-ada'),
  grace: uniqueEmail('offline-grace'),
}

const test = base.extend<{
  /** Make this test's browser `who`: their session cookie replaces whoever was there. */
  signIn: (who: keyof typeof ACCOUNTS) => Promise<SignedIn>
}>({
  signIn: async ({ signInCache, context }, use) => {
    await use(async (who) => {
      const { userId, storageState } = await signInCache(ACCOUNTS[who], who)
      await context.addCookies(storageState.cookies)
      return { id: userId, email: ACCOUNTS[who] }
    })
  },
})

// Every other suite runs with service workers blocked (playwright.config.ts).
test.use({ serviceWorkers: 'allow' })
test.describe.configure({ mode: 'default' })

const NOTES = '/api/pwa/example/notes'

/** A note no other test, and no earlier run against this server, has written. */
const unique = (text: string) => `${text} ${Math.random().toString(36).slice(2, 8)}`

const hydrated = (page: Page) =>
  page.waitForFunction(
    () =>
      (window as unknown as { useNuxtApp?: () => { isHydrating?: boolean } }).useNuxtApp?.()
        .isHydrating === false,
  )

/** The paths the worker holds in each personal cache. */
const kept = (page: Page) =>
  page.evaluate(async () => {
    const paths: Record<string, string[]> = { pages: [], data: [], assets: [] }
    for (const name of await caches.keys()) {
      const kind = /^pwa-personal-(pages|data|assets)-/.exec(name)?.[1]
      if (!kind) continue
      const requests = await (await caches.open(name)).keys()
      paths[kind]!.push(...requests.map((request) => new URL(request.url).pathname))
    }
    return paths
  })

/** What is in the outbox's IndexedDB store, whoever made it. */
const stored = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<Array<{ owner: string; state: string; body: unknown }>>((resolve, reject) => {
        const opening = indexedDB.open('pwa-outbox')
        opening.onerror = () => reject(opening.error)
        opening.onsuccess = () => {
          const db = opening.result
          if (!db.objectStoreNames.contains('writes')) return resolve([])
          const all = db.transaction('writes').objectStore('writes').getAll()
          all.onsuccess = () => resolve(all.result)
        }
      }),
  )

/**
 * Open the example page with the worker in charge, and wait until it has
 * stopped storing what the page loaded. The first load of a context is not the
 * worker's (it registers after it), so the page is loaded twice, as a
 * returning person's would have been.
 */
async function openExample(page: Page): Promise<void> {
  await page.goto('/pwa-example')
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
  await page.reload({ waitUntil: 'networkidle' })
  await hydrated(page)
  let last = -1
  await expect
    .poll(async () => {
      const now = Object.values(await kept(page)).flat().length
      const settled = now > 0 && now === last
      last = now
      return settled
    })
    .toBe(true)
}

/** How many of the signed-in account's notes on the server say exactly `text`. */
const onServer = async (context: BrowserContext, text: string) =>
  ((await (await context.request.get(NOTES)).json()) as { notes: Array<{ text: string }> }).notes
    .map((note) => note.text)
    .filter((saved) => saved === text).length

const note = (page: Page) => page.getByRole('textbox', { name: 'Note' })
const save = (page: Page) => page.getByRole('button', { name: 'Save' })
const notes = (page: Page) => page.getByRole('list', { name: 'Notes' })
const waitingLine = (page: Page) => page.getByText(/saved on this device/)
const notSaved = (page: Page) => page.getByRole('list', { name: 'Not saved' })
const offlinePage = (page: Page) => page.getByRole('heading', { name: 'You are offline' })

test('an offline route opens from its copy with the network cut, and so does its data', async ({
  page,
  context,
  signIn,
}) => {
  const { email } = await signIn('main')
  const text = unique('Squat 5x5')
  await context.request.post(NOTES, { data: { text } })
  await openExample(page)
  // The page's own GET, as its `refresh()` makes after a write.
  await page.evaluate((url) => fetch(url), NOTES)

  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Offline example' })).toBeVisible()
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible()
  await expect(notes(page)).toContainText(text)
  // Not just markup: the kept build files ran.
  await hydrated(page)

  const data = await page.evaluate((url) => fetch(url).then((response) => response.json()), NOTES)
  expect(data.notes).toContainEqual({ id: expect.any(String), text })

  // A route nobody named still gets the offline page.
  await page.goto('/pwa-example-is-the-only-route-named')
  await expect(offlinePage(page)).toBeVisible()
})

test('a write made offline is kept on the device, survives a reload, and is sent when the connection returns', async ({
  page,
  context,
  signIn,
}) => {
  await signIn('main')
  const text = unique('Deadlift 3x5')
  await openExample(page)

  await context.setOffline(true)
  await note(page).fill(text)
  await save(page).click()
  await expect(waitingLine(page)).toContainText('1 saved on this device')
  await expect(note(page)).toHaveValue('')

  await page.reload()
  await hydrated(page)
  await expect(waitingLine(page)).toContainText('1 saved on this device')
  expect(await onServer(context, text)).toBe(0)

  // Nothing is clicked from here on: under `nuxt dev` Vite reloads the page
  // when it finds its server again, and the outbox goes out either way (on
  // `online`, or on the load).
  await context.setOffline(false)
  await expect.poll(() => onServer(context, text)).toBe(1)
  await expect(waitingLine(page)).toHaveCount(0)
  await expect(notes(page)).toContainText(text)
  expect(await stored(page)).toEqual([])
  expect(await onServer(context, text)).toBe(1)
})

test('a write whose answer was lost is sent again with the same key, and lands once', async ({
  page,
  context,
  signIn,
}) => {
  await signIn('main')
  const text = unique('Bench 5x5')
  await openExample(page)

  const posts: Array<{ key: string | undefined; replayed: string | undefined }> = []
  page.on('response', (response) => {
    const request = response.request()
    if (request.method() !== 'POST' || !request.url().endsWith(NOTES)) return
    posts.push({
      key: request.headers()['idempotency-key'],
      replayed: response.headers()['idempotent-replayed'],
    })
  })
  // The first attempt reaches the server, which writes; its answer never arrives.
  let lost = false
  await page.route(`**${NOTES}`, async (route) => {
    if (route.request().method() !== 'POST' || lost) return route.fallback()
    lost = true
    await route.fetch()
    await route.abort('connectionreset')
  })

  await note(page).fill(text)
  await save(page).click()
  await expect(notes(page)).toContainText(text)
  await expect(waitingLine(page)).toHaveCount(0)

  expect(lost).toBe(true)
  expect(await onServer(context, text)).toBe(1)
  // The one answer the page saw was the replay's, marked as such.
  expect(posts).toEqual([{ key: expect.stringMatching(/^[\w-]{36}$/), replayed: 'true' }])
  expect(await stored(page)).toEqual([])
})

/** Leave a write the server refuses in the outbox: its first attempt finds no connection. */
async function saveRejectedNote(page: Page): Promise<void> {
  let dropped = false
  await page.route(`**${NOTES}`, (route) => {
    if (route.request().method() !== 'POST' || dropped) return route.fallback()
    dropped = true
    return route.abort('internetdisconnected')
  })
  // Over the route's 60 characters, which only the server checks.
  await note(page).fill('x'.repeat(61))
  await save(page).click()
  await expect(notSaved(page)).toContainText('Not saved: A note is 1 to 60 characters long')
}

test('a write the server rejects is kept and shown until the person discards it', async ({
  page,
  context,
  signIn,
}) => {
  const { id } = await signIn('main')
  await openExample(page)
  await saveRejectedNote(page)
  expect(await stored(page)).toEqual([
    expect.objectContaining({ owner: id, state: 'failed', body: { text: 'x'.repeat(61) } }),
  ])

  // Still there after a reload, and not sent again by it.
  await page.reload()
  await hydrated(page)
  await expect(notSaved(page)).toBeVisible()

  await page.getByRole('button', { name: 'Discard' }).click()
  await expect(notSaved(page)).toHaveCount(0)
  expect(await stored(page)).toEqual([])
  expect(await onServer(context, 'x'.repeat(61))).toBe(0)
})

/** Everything this layer can leave on a device for `ada`: a kept page, kept data, a write in the outbox. */
async function leaveTraces(page: Page, context: BrowserContext, ada: SignedIn): Promise<void> {
  await context.request.post(NOTES, { data: { text: 'Ada, private' } })
  await openExample(page)
  await page.evaluate((url) => fetch(url), NOTES)
  await saveRejectedNote(page)

  const copies = await kept(page)
  expect(copies.pages).toContain('/pwa-example')
  expect(copies.data).toContain(NOTES)
  expect((await stored(page)).map((entry) => entry.owner)).toEqual([ada.id])
}

test("signing out deletes the kept page, its data and the outbox, and the next account never sees the last one's", async ({
  page,
  context,
  signIn,
}) => {
  const ada = await signIn('ada')
  await leaveTraces(page, context, ada)

  // The page's own button, not the app's menu: a fork has its own header.
  await page.getByTestId('pwa-example-sign-out').click()
  await expect
    .poll(async () => {
      const copies = await kept(page)
      return [copies.pages, copies.data, await stored(page)]
    })
    .toEqual([[], [], []])

  // Grace signs in on the same browser and has no connection before she has
  // loaded anything: there is no copy to show her, Ada's least of all.
  const grace = await signIn('grace')
  await context.setOffline(true)
  await page.goto('/pwa-example')
  await expect(offlinePage(page)).toBeVisible()
  await expect(page.locator('body')).not.toContainText(ada.email)
  expect(
    await page.evaluate(
      (url) =>
        fetch(url).then(
          () => 'answered',
          () => 'failed',
        ),
      NOTES,
    ),
  ).toBe('failed')

  // With a connection she gets her own page, and that is what is kept for her.
  await context.setOffline(false)
  await openExample(page)
  await expect(page.getByText(`Signed in as ${grace.email}`)).toBeVisible()
  await expect(notes(page)).toHaveCount(0)
  await expect(notSaved(page)).toHaveCount(0)

  await context.setOffline(true)
  await page.reload()
  await expect(page.getByText(`Signed in as ${grace.email}`)).toBeVisible()
  await expect(page.locator('body')).not.toContainText(ada.email)
  await expect(page.locator('body')).not.toContainText('Ada, private')
})

test('an account that replaces another without a sign-out clears what the first one left', async ({
  page,
  context,
  signIn,
}) => {
  const ada = await signIn('ada')
  await leaveTraces(page, context, ada)

  // The cookie changes hands with no sign-out in between, and the next page
  // Grace loads is not an offline route.
  const grace = await signIn('grace')
  await page.goto('/terms')
  // The owner is settled from onNuxtReady, after hydration. page.goto returns
  // at the load event, and on a loaded CI runner the dev server's client took
  // over 4 s more to mount, which spent the poll's whole window before the
  // plugin had run at all.
  await hydrated(page)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('pwa:owner'))).toBe(grace.id)
  const copies = await kept(page)
  expect([copies.pages, copies.data, await stored(page)]).toEqual([[], [], []])

  await context.setOffline(true)
  await page.goto('/pwa-example')
  await expect(offlinePage(page)).toBeVisible()
  await expect(page.locator('body')).not.toContainText(ada.email)
})

// No page of the app is open when the connection returns, so only the worker
// can send: the sync Chromium fires by itself where it allows one, and the one
// handed to the worker here over CDP (DevTools' "Sync" button) where it does not.
test('the worker sends the outbox on a Background Sync, with the app closed', async ({
  page,
  context,
  signIn,
}) => {
  await signIn('main')
  const text = unique('Row 3x8')
  await openExample(page)
  const origin = new URL(page.url()).origin

  await context.setOffline(true)
  await note(page).fill(text)
  await save(page).click()
  await expect(waitingLine(page)).toContainText('1 saved on this device')

  // The offline page is plain HTML: nothing on it listens for `online`.
  await page.goto('/offline')
  await expect(offlinePage(page)).toBeVisible()
  await context.setOffline(false)

  const cdp = await context.newCDPSession(page)
  const registered = new Promise<string>((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
      const mine = registrations.find((entry) => entry.scopeURL.startsWith(origin))
      if (mine) resolve(mine.registrationId)
    })
  })
  await cdp.send('ServiceWorker.enable')
  await cdp.send('ServiceWorker.dispatchSyncEvent', {
    origin,
    registrationId: await registered,
    tag: 'pwa-outbox',
    lastChance: false,
  })

  await expect.poll(() => onServer(context, text)).toBe(1)
  await expect.poll(() => stored(page)).toEqual([])
  expect(await onServer(context, text)).toBe(1)
})
