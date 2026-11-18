# PWA: the service worker, offline pages, the outbox, push and install

The pwa layer (`layers/pwa/`): a service worker, the page it shows when a navigation finds no network, Web Push sent from the Worker, and the settings for installing the app and turning notifications on. For an app that names routes, it also keeps those pages so they open with no network, and gives writes made there an outbox. Core already serves the manifest (`server/routes/manifest.webmanifest.get.ts`) and the icons, so with this layer the app installs to a home screen, fails politely offline and can notify the person.

> **Load this when:** touching `layers/pwa/`, adding anything to the service worker, making a page work offline, queueing a write, sending a notification, or debugging a page that behaves differently once installed.
> Canonical index: [AGENTS.md](../../AGENTS.md).

---

## What it does

| Piece | File | Notes |
| --- | --- | --- |
| `GET /sw.js` | `layers/pwa/server/routes/sw.js.get.ts` | The worker's source with this deploy's build id and `app.baseURL` filled in. 404 when the layer is off |
| The worker | `layers/pwa/server/utils/service-worker.ts`, types in `service-worker-scope.ts` | One function, sent to the browser as its own source. Answers navigations, keeps copies for offline routes, shows pushes, handles a click on one, sends the outbox on a Background Sync |
| `GET /offline` | `layers/pwa/server/routes/offline.get.ts`, `layers/pwa/server/utils/offline-page.ts` | One self-contained HTML document in the brand's colours |
| Registration | `layers/pwa/app/plugins/pwa.client.ts` | Registers once the app is idle; unregisters when the layer is off. Also captures the install prompt, drops a signed-out browser's push subscription, clears personal copies when the account changes and sends the outbox |
| `useOutbox()` | `layers/pwa/app/composables/useOutbox.ts`, core in `layers/pwa/shared/utils/outbox.ts` | A write that survives having no connection. See The outbox |
| `idempotent()` | `layers/pwa/server/utils/idempotency.ts`, table code in `idempotency-keys.ts` | The server half: a replayed write is answered, not written again |
| `pwa_idempotency_keys` | `layers/pwa/server/db/schema.ts` | One row per keyed write, for 14 days. Deleted with the account, swept by the purge task |
| `/pwa-example` | `layers/pwa/app/pages/pwa-example.vue`, `layers/pwa/server/api/pwa/example/` | Dev only: the worked example of an offline route and the outbox, and what the browser spec drives |
| `sendPush()` | `layers/pwa/server/utils/push.ts`, with `push-send.ts` and `push-crypto.ts` beside it | One notification to every browser a person turned them on in. See Push |
| `push_subscriptions` | `layers/pwa/server/db/schema.ts`, `layers/pwa/server/utils/push-subscriptions.ts` | One row per browser. Deleted with the account, listed in the data export |
| `/api/pwa/push/*` | `layers/pwa/server/api/pwa/push/` | `key` (GET), `subscribe`, `unsubscribe`, `status` (POST). Signed-in only; 404 without VAPID keys |
| `usePwaInstall()`, `usePushSubscription()` | `layers/pwa/app/composables/` | Install state and prompt; permission, subscribe, unsubscribe |
| `<PwaDeviceSettings />` | `layers/pwa/app/components/Pwa/DeviceSettings.vue` | The card that uses both. Also at `/settings/device` |

**Until an app names `offlineRoutes`, the worker caches one thing: the offline page.** Every navigation goes to the network, and the cached page is the answer only when the fetch itself fails. A 404 or a 500 is an answer and goes through untouched. Scripts, styles, API calls and images never pass through the worker, and nothing a signed-in person sees is written to a cache. What changes once routes are named is under Offline routes.

Each deploy has a new build id, so each deploy installs a new worker, which caches a fresh offline page and deletes every cache the last deploy made. It takes over at once (`skipWaiting`, `clients.claim`): every cache is per deploy, so an old page never meets a new worker's copies, and there is no "new version" prompt to build.

## Options

```ts
// nuxt.config.ts › runtimeConfig.public
pwa: {
  offlineTitle: 'The post is not getting through',
  offlineRoutes: ['/training'],
  offlineApi: ['/api/training'],
},
```

| Option (`NUXT_PUBLIC_PWA_*`) | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` | `false` turns `/sw.js` and `/offline` into 404s and unregisters the worker on each visitor's next visit |
| `offlineTitle` | `You are offline` | The offline page's heading |
| `offlineBody` | `This page needs a connection. Check yours, then try again.` | The sentence under it |
| `offlineRetry` | `Try again` | The link that loads the page again |
| `offlineRoutes` | `[]` | Paths whose pages open from a kept copy when there is no network. Empty = nothing but the offline page is kept. See Offline routes |
| `offlineApi` | `[]` | Paths whose GET responses are kept for those pages |
| `vapidPublicKey` | empty | Push: the key browsers subscribe with. See Push |

The offline page takes its colours from `BRAND_OG_COLORS` (`shared/utils/brand-colors.generated.ts`), so a fork's page is in its own palette without editing the layer. Like the manifest it has no colour mode.

Server-only (`NUXT_PWA_*`): `vapidPrivateKey` (a secret) and `vapidSubject` (defaults to `appUrl`).

Both lists take a path and everything under it (`/training` covers `/training/today`, not `/trainings`). As env values they are JSON arrays: `NUXT_PUBLIC_PWA_OFFLINE_ROUTES='["/training"]'`.

A fork vendors it with `bun run layers:pull pwa`, adds the layer's `export *` line to `server/db/schema.ts` and runs `bun run db:generate` (again after a pull that adds a table). It has two tables, one secret and no dependencies.

## Offline routes

Off until the app names routes. Then, for same-origin GETs only:

| Request | What the worker does | Kept in |
| --- | --- | --- |
| A navigation under `offlineRoutes` | Network first, and a copy of a 200 is kept. When the fetch fails: the copy, and only without one the offline page | `pwa-personal-pages-<build>`, 30 entries |
| A GET under `offlineApi` | The same, without the offline page | `pwa-personal-data-<build>`, 100 entries |
| A file under `/_nuxt/` | The copy if there is one (a hashed file never changes), else the network, kept | `pwa-personal-assets-<build>`, 400 entries |

- **A copy is only ever the answer to a failed fetch** (hashed build files aside). Online, the person always gets what the server says now.
- **A copy follows the server.** A redirect, a 403 or a 404 for a kept URL deletes its copy. A 5xx leaves it. A 401 under `offlineApi` deletes every personal cache: the session is over.
- **Bounded.** Past its limit a cache drops its oldest entries (checked on the first write and every twentieth, so the bound is approximate). **Per deploy**: a new build's worker deletes the old build's caches, since a kept page names the old build's files. The first visit after a deploy has to be online.
- **`Cache-Control` is not consulted.** Naming a route is the app saying "keep this", `no-store` or not. Name only what one person may see again on their own device.
- **What is kept is what was loaded.** A page has a copy once it has been loaded as a full navigation with the worker in control (so not the very first visit to the site). Moving between pages inside the app needs no HTML, only the route's script, kept if it was ever loaded, and its data, kept if a GET under `offlineApi` fetched it. A page that fetches on the client must handle the fetch failing.
- **Not kept:** images, fonts, icons fetched from an API (`/api/_nuxt_icon`, off in this template), anything from another origin (including build files behind `app.cdnURL`), anything with a body.
- **Under `nuxt dev`** build files are not hashed, so they go network first, and the cache holds thousands of modules.

### Whose copies they are

Everything in those three caches, and the outbox, belongs to the account that was signed in. The rule, enforced by the client plugin (`layers/pwa/app/utils/pwa-personal.ts`):

- The browser records which account the copies belong to (`localStorage` `pwa:owner`).
- On every load, and whenever `useUserSession()` changes, that record is compared with who is signed in. If it names someone and that is no longer who is signed in (signed out, session expired, another account), **every personal cache and the whole outbox are deleted**, and only then is the record updated. A clear cut short by a page unload runs again on the next load.
- The worker is told too (`pwa:forget`), and stops keeping responses that were already on their way when the person left.
- Nothing is cleared when nobody owned the copies, so a sign-in that lands on an offline route keeps the page just stored for it.

What that does not cover: a device that has not loaded the app online since the session ended cannot know it ended. Offline, it still opens the last account's kept pages, exactly as it would if that person were still signed in. And **an expired session counts as a sign-out**: writes still in the outbox are deleted with everything else, unsent.

## The outbox

For a write that must survive having no connection. On the page:

```ts
const outbox = useOutbox()

const result = await outbox.send('/api/training/sessions', { body: { reps: 5 } })
if (result.queued) {
  // Stored on the device. It is in outbox.waiting until it has been sent.
} else {
  result.data // the server's answer
}
```

```vue
<p v-if="outbox.waiting.value.length" role="status">
  {{ outbox.waiting.value.length }} saved on this device. They will send when you are back online.
</p>
```

On the server, the route wraps its write:

```ts
export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)
  const body = await readValidatedBody(event, schema.parse)
  return idempotent(event, user.id, () => saveSession(db, user.id, body))
})
```

- **`send()`** goes straight to the server when the browser is online and nothing is queued ahead, and resolves `{ queued: false, data }`. With no connection, no answer within 10 seconds (`timeout`), or writes already waiting, it is stored in IndexedDB and resolves `{ queued: true, id }`. An error the server answers with now (a 400, a 500) is thrown as `$fetch` would throw it and nothing is stored: that one is the caller's to show.
- **Replay** is in the order the writes were made: when the browser fires `online`, on the next load, every 30 seconds while the page is open and something is waiting, and on a Background Sync where there is one (Chromium only; there the worker sends even with the app closed). No connection, a 5xx, 408, 429 or any answer with `Retry-After` stops the replay there and keeps the order.
- **A rejected write is kept.** Any other 4xx, or a fifth 5xx, moves the write to `outbox.failed` with `error.status` and `error.message` (the route's own `message`, so write it as a sentence a person can read later). It stays until the app calls `outbox.retry(entry)` or `outbox.discard(entry)`. Writes behind it go on.
- **Every attempt carries `Idempotency-Key`**, the first included, so a write whose answer was lost is replayed under the key the server already saw. `idempotent()` stores the first answer (status and JSON body, up to 64 KB) per account and key for 14 days, and gives it back with `Idempotent-Replayed: true` without running the write. A second request while the first is still running gets a 409 with `Retry-After`. A write that throws leaves no record. A request with no key runs as it always did.
- **`idempotent()` is not a transaction.** If the isolate dies after the write and before the answer is recorded, the key is taken over 60 seconds later and the write runs again. A write that cannot tolerate that stores the key on its own row under a unique index.
- **POST, PUT or PATCH, JSON bodies only.** No DELETE (a DELETE with a body hangs on Workers), no files.
- **One account's writes are never sent as another's.** Each is stored with its owner; a replay from the page deletes anyone else's unsent, and `idempotent()` answers 403 to a write whose `X-Outbox-Owner` is not the session's user (the worker replays without knowing who is signed in). So every route the outbox writes to must use `idempotent()`.
- **Cleared on sign-out** with the caches. See Whose copies they are.
- The outbox is the page's own: it works with the worker switched off, minus Background Sync.

### What an app does to opt in

1. Name the routes and the read APIs in `runtimeConfig.public.pwa` (`offlineRoutes`, `offlineApi`).
2. Read with `useFetch` from paths under `offlineApi`.
3. Write with `useOutbox().send()`, and wrap the route's write in `idempotent()`.
4. Show `outbox.waiting` and `outbox.failed` somewhere the person will see them, with a way to retry or discard a failed one.
5. Sign out through `useUserSession().clear()` (core's `useSignOut()` does), so the plugin sees it.

`/pwa-example` does all five in one page; run it under `bun dev` with the two env values in its header comment.

## Push

```ts
// anywhere on the server: a route, a task, a queue consumer
await sendPush(userId, { title: 'Your plan changed', body: 'Coach moved Thursday.', url: '/training' })
```

`sendPush` returns `{ sent, removed, failed }` and never throws for a push service's answer, so it cannot fail the action that caused it. It is for product notifications. A problem with the app itself goes to `ops_events` and fleet, never to a person's phone.

- **No keys, no push.** With either VAPID key unset, every `/api/pwa/push/*` route is a 404, the settings card leaves the notifications row out, and `sendPush` returns zeros. One key without the other logs `push_half_configured`.
- **Encryption** is RFC 8291 (`aes128gcm`) and the request is signed per RFC 8292 (VAPID, an ES256 JWT), both on WebCrypto with no library. `layers/pwa/test/push-crypto.test.ts` holds the encryption to the RFC's own test vector.
- **A dead subscription deletes itself**: a 404 or 410 from the push service removes the row. Anything else (403, 429, 5xx, no answer) is logged as `push_rejected` or `push_failed` with the service's host and the row stays. `last_success_at` is the last time a service accepted a message.
- **Endpoints are allowlisted** (`PUSH_SERVICE_HOSTS` in `layers/pwa/shared/utils/push.ts`: FCM, Mozilla, WNS, Apple). The endpoint is a URL the Worker will POST to and it comes from the client. A browser on another push service is refused at subscribe; add its host there.
- **One browser, one account.** The endpoint is unique. When a second account subscribes in the same browser the row moves to it, and the settings switch asks the server (`status`) because the browser keeps its subscription across sign-ins. A signed-out browser drops its subscription on the next page load.
- **Ten subscriptions per account** (`MAX_PUSH_SUBSCRIPTIONS_PER_USER`); the oldest makes room. Each send is one subrequest per row.
- **The message** is `{ title, body, url }`. Title and body are clipped to 100 and 300 characters. `url` must be same-origin: a click focuses a window already on it or opens one, and anything else goes to the home page. `pushsubscriptionchange` is not handled.
- **Nothing is cached.** The worker shows the notification and keeps nothing.

### Keys

Make one pair per app, once. Changing the public key ends every existing subscription. The script never writes the private key to a terminal:

```bash
bun layers/pwa/scripts/vapid-keys.ts | bunx wrangler secret put NUXT_PWA_VAPID_PRIVATE_KEY
```

It prints the public key with the command that stores it (`NUXT_PUBLIC_PWA_VAPID_PUBLIC_KEY`, also with `wrangler secret put`: it is not a secret, but that keeps the pair in one place and out of `wrangler.toml`). For local dev:

```bash
bun layers/pwa/scripts/vapid-keys.ts --env >> .env
```

`NUXT_PWA_VAPID_SUBJECT` is who a push service contacts about the sender: a `mailto:` or `https:` URL, by default `appUrl`. Apple refuses a `localhost` subject, so set a real one before testing against Safari from a dev machine.

## Install and the settings card

`usePwaInstall()` gives `installed` (running standalone), `canPrompt` with `prompt()` (Chrome's `beforeinstallprompt`, captured by the client plugin because it fires before any page mounts), and `needsHomeScreen` (iOS, not installed). iOS has no prompt in any browser: the person taps Share, then Add to Home Screen, and **push on iOS exists only after that**, from iOS 16.4.

`usePushSubscription()` gives `configured`, `supported`, `permission`, `subscribed`, `pending`, and `refresh()`, `subscribe()`, `unsubscribe()`. Only `subscribe()` asks the browser for permission, so call it from a click.

`<PwaDeviceSettings />` is the card built on both. Notifications are off until the person turns the switch on, the permission question appears only then, and a row with nothing to offer is left out (the whole card too). Put it on the app's own settings page; `/settings/device` hosts it for an app that has not.

## Changing the worker

`serviceWorker()` is serialised with `toString()`, so it **must read nothing outside its own body**: no imports, no module-level constants, no helpers. Whatever it needs arrives in its `config` argument. `outbox()` (`layers/pwa/shared/utils/outbox.ts`) lives by the same rule: the page imports it, and `/sw.js` sends its source as the worker's third argument, so one implementation replays in both places. A reference that escapes typechecks, passes most unit tests (which call the functions directly) and then throws in the browser; `service-worker.test.ts` evaluates the rendered script with nothing in scope, and `layers/pwa/test/e2e/` runs it in a browser.

Those specs run against the dev server. Wrangler bundles the deployed Worker again, so after a change to the worker also check it once on a build: `bun run build`, `bunx wrangler --cwd .output dev`, then load a page, cut the network in DevTools and navigate.

`push` must always end in `showNotification`: browsers revoke the subscription of a worker that receives pushes silently.

Before adding a cache, decide who clears it. Anything personal has to go on sign-out, and a response cached for one account must never be served to the next person on the same device: name it under `PWA_PERSONAL_CACHE_PREFIX` and the existing clear covers it. `offline.spec.ts` holds the two-account proof; it fails if `settlePwaOwner` stops clearing.

The browser suites run with `serviceWorkers: 'block'` (`playwright.config.ts`) so no other spec's requests pass through a worker. A spec that needs one opts in with `test.use({ serviceWorkers: 'allow' })`.

## What the tests do not reach

Offline routes and the outbox are tested in Chromium only, against `nuxt dev`. Not covered by any test:

- **Safari and iOS, in any form.** They have no Background Sync, so a queued write waits for `online` or the next time the app is opened. Safari deletes all of a site's script-writable storage (Cache Storage, IndexedDB, the worker itself) after about seven days without a visit unless the app is on the Home Screen: kept pages go, and so does an unsent write. `navigator.onLine` and the `online` event are less dependable there. Web Locks need Safari 15.4 and the replay time limit Safari 16; without them the outbox still works, with one replay per tab.
- **Firefox**, which also has no Background Sync.
- **A real Background Sync.** The spec hands the worker a sync over CDP; when and whether Chromium fires one by itself (it needs the site to be installed or engaged with) is not tested.
- **A weak connection.** The specs cut the network cleanly. A navigation that hangs is not timed out by the worker: the person waits for the browser to give up before the kept copy shows.
- **Storage running out.** A copy that cannot be stored is skipped silently; a write that cannot be stored makes `send()` throw.

Headless Chromium under Playwright has no push service and answers "denied" to every notification permission, whatever a context is granted. So `device-settings.spec.ts` replaces `PushManager.subscribe` and the permission answer, and `pwa.spec.ts` hands the worker a real push over CDP and records the `showNotification` call it makes. Not covered by any test: a message accepted by a real push service and shown on a device, the browser's own permission dialog, Safari and iOS in any form, Firefox, and a click on a real notification (`notificationclick` is unit-tested against a fake scope). Check those by hand on a deployed app with keys set before relying on push.

## Removing it

An installed worker outlives the code that registered it. Ship one release with `NUXT_PUBLIC_PWA_ENABLED=false` first, so returning visitors' browsers unregister it (which ends their push subscriptions too), then delete `layers/pwa/`, its `export *` line in `server/db/schema.ts` (then `bun run db:generate` drops `push_subscriptions` and `pwa_idempotency_keys`) and the two VAPID secrets. That release also deletes the personal caches. Writes still in an outbox stay in the browser's IndexedDB, unsent, so stop calling `useOutbox()` a release earlier if any could be waiting. A worker left behind stays until the person clears site data.
