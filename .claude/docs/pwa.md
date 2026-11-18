# PWA: the service worker, the offline page, push and install

The pwa layer (`layers/pwa/`): a service worker, the page it shows when a navigation finds no network, Web Push sent from the Worker, and the settings for installing the app and turning notifications on. Core already serves the manifest (`server/routes/manifest.webmanifest.get.ts`) and the icons, so with this layer the app installs to a home screen, fails politely offline and can notify the person.

> **Load this when:** touching `layers/pwa/`, adding anything to the service worker, sending a notification, or debugging a page that behaves differently once installed.
> Canonical index: [AGENTS.md](../../AGENTS.md).

---

## What it does

| Piece | File | Notes |
| --- | --- | --- |
| `GET /sw.js` | `layers/pwa/server/routes/sw.js.get.ts` | The worker's source with this deploy's build id and `app.baseURL` filled in. 404 when the layer is off |
| The worker | `layers/pwa/server/utils/service-worker.ts` | One function, sent to the browser as its own source. Answers navigations only, shows pushes, handles a click on one |
| `GET /offline` | `layers/pwa/server/routes/offline.get.ts`, `layers/pwa/server/utils/offline-page.ts` | One self-contained HTML document in the brand's colours |
| Registration | `layers/pwa/app/plugins/pwa.client.ts` | Registers once the app is idle; unregisters when the layer is off. Also captures the install prompt and drops a signed-out browser's push subscription |
| `sendPush()` | `layers/pwa/server/utils/push.ts`, with `push-send.ts` and `push-crypto.ts` beside it | One notification to every browser a person turned them on in. See Push |
| `push_subscriptions` | `layers/pwa/server/db/schema.ts`, `layers/pwa/server/utils/push-subscriptions.ts` | One row per browser. Deleted with the account, listed in the data export |
| `/api/pwa/push/*` | `layers/pwa/server/api/pwa/push/` | `key` (GET), `subscribe`, `unsubscribe`, `status` (POST). Signed-in only; 404 without VAPID keys |
| `usePwaInstall()`, `usePushSubscription()` | `layers/pwa/app/composables/` | Install state and prompt; permission, subscribe, unsubscribe |
| `<PwaDeviceSettings />` | `layers/pwa/app/components/Pwa/DeviceSettings.vue` | The card that uses both. Also at `/settings/device` |

**The worker caches one thing: the offline page.** Every navigation goes to the network, and the cached page is the answer only when the fetch itself fails. A 404 or a 500 is an answer and goes through untouched. Scripts, styles, API calls and images never pass through the worker, and nothing a signed-in person sees is written to a cache.

Each deploy has a new build id, so each deploy installs a new worker, which caches a fresh offline page and deletes the last deploy's. It takes over at once (`skipWaiting`, `clients.claim`): pages come from the network, so an old page never meets a new worker's cache, and there is no "new version" prompt to build.

## Options

```ts
// nuxt.config.ts › runtimeConfig.public
pwa: { offlineTitle: 'The post is not getting through' },
```

| Option (`NUXT_PUBLIC_PWA_*`) | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` | `false` turns `/sw.js` and `/offline` into 404s and unregisters the worker on each visitor's next visit |
| `offlineTitle` | `You are offline` | The offline page's heading |
| `offlineBody` | `This page needs a connection. Check yours, then try again.` | The sentence under it |
| `offlineRetry` | `Try again` | The link that loads the page again |
| `vapidPublicKey` | empty | Push: the key browsers subscribe with. See Push |

The offline page takes its colours from `BRAND_OG_COLORS` (`shared/utils/brand-colors.generated.ts`), so a fork's page is in its own palette without editing the layer. Like the manifest it has no colour mode.

Server-only (`NUXT_PWA_*`): `vapidPrivateKey` (a secret) and `vapidSubject` (defaults to `appUrl`).

A fork vendors it with `bun run layers:pull pwa`, adds the layer's `export *` line to `server/db/schema.ts` and runs `bun run db:generate`. It has one table, one secret and no dependencies.

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

`serviceWorker()` is serialised with `toString()`, so it **must read nothing outside its own body**: no imports, no module-level constants, no helpers. Whatever it needs arrives in its `config` argument. A reference that escapes typechecks, passes the unit tests (which call the function directly) and then throws in the browser; `layers/pwa/test/e2e/pwa.spec.ts` is the test that catches it.

That spec runs against the dev server. Wrangler bundles the deployed Worker again, so after a change to the worker also check it once on a build: `bun run build`, `bunx wrangler --cwd .output dev`, then load a page, cut the network in DevTools and navigate.

`push` must always end in `showNotification`: browsers revoke the subscription of a worker that receives pushes silently.

Before adding a cache, decide who clears it. Anything personal has to go on sign-out, and a response cached for one account must never be served to the next person on the same device.

The browser suites run with `serviceWorkers: 'block'` (`playwright.config.ts`) so no other spec's requests pass through a worker. A spec that needs one opts in with `test.use({ serviceWorkers: 'allow' })`.

## What the tests do not reach

Headless Chromium under Playwright has no push service and answers "denied" to every notification permission, whatever a context is granted. So `device-settings.spec.ts` replaces `PushManager.subscribe` and the permission answer, and `pwa.spec.ts` hands the worker a real push over CDP and records the `showNotification` call it makes. Not covered by any test: a message accepted by a real push service and shown on a device, the browser's own permission dialog, Safari and iOS in any form, Firefox, and a click on a real notification (`notificationclick` is unit-tested against a fake scope). Check those by hand on a deployed app with keys set before relying on push.

## Removing it

An installed worker outlives the code that registered it. Ship one release with `NUXT_PUBLIC_PWA_ENABLED=false` first, so returning visitors' browsers unregister it (which ends their push subscriptions too), then delete `layers/pwa/`, its `export *` line in `server/db/schema.ts` (then `bun run db:generate` drops `push_subscriptions`) and the two VAPID secrets. A worker left behind is harmless (it only ever shows the offline page it cached) but stays until the person clears site data.
