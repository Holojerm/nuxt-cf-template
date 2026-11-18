# PWA: the service worker and the offline page

The pwa layer (`layers/pwa/`): a service worker, the page it shows when a navigation finds no network, and the client plugin that registers it. Core already serves the manifest (`server/routes/manifest.webmanifest.get.ts`) and the icons, so with this layer the app installs to a home screen and fails politely offline.

> **Load this when:** touching `layers/pwa/`, adding anything to the service worker, or debugging a page that behaves differently once installed.
> Canonical index: [AGENTS.md](../../AGENTS.md).

---

## What it does

| Piece | File | Notes |
| --- | --- | --- |
| `GET /sw.js` | `layers/pwa/server/routes/sw.js.get.ts` | The worker's source with this deploy's build id and `app.baseURL` filled in. 404 when the layer is off |
| The worker | `layers/pwa/server/utils/service-worker.ts` | One function, sent to the browser as its own source. Answers navigations only |
| `GET /offline` | `layers/pwa/server/routes/offline.get.ts`, `layers/pwa/server/utils/offline-page.ts` | One self-contained HTML document in the brand's colours |
| Registration | `layers/pwa/app/plugins/pwa.client.ts` | Registers once the app is idle; unregisters when the layer is off |

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

The offline page takes its colours from `BRAND_OG_COLORS` (`shared/utils/brand-colors.generated.ts`), so a fork's page is in its own palette without editing the layer. Like the manifest it has no colour mode.

A fork vendors it with `bun run layers:pull pwa`. It has no tables, no secrets and no dependencies.

## Changing the worker

`serviceWorker()` is serialised with `toString()`, so it **must read nothing outside its own body**: no imports, no module-level constants, no helpers. Whatever it needs arrives in its `config` argument. A reference that escapes typechecks, passes the unit tests (which call the function directly) and then throws in the browser; `layers/pwa/test/e2e/pwa.spec.ts` is the test that catches it.

That spec runs against the dev server. Wrangler bundles the deployed Worker again, so after a change to the worker also check it once on a build: `bun run build`, `bunx wrangler --cwd .output dev`, then load a page, cut the network in DevTools and navigate.

Before adding a cache, decide who clears it. Anything personal has to go on sign-out, and a response cached for one account must never be served to the next person on the same device.

The browser suites run with `serviceWorkers: 'block'` (`playwright.config.ts`) so no other spec's requests pass through a worker. A spec that needs one opts in with `test.use({ serviceWorkers: 'allow' })`.

## Removing it

An installed worker outlives the code that registered it. Ship one release with `NUXT_PUBLIC_PWA_ENABLED=false` first, so returning visitors' browsers unregister it, then delete `layers/pwa/`. A worker left behind is harmless (it only ever shows the offline page it cached) but stays until the person clears site data.
