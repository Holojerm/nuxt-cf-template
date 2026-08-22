# Images

Two transform paths, split by whether the image is behind a session. Getting the
wrong one produces a broken image in dev or a 401 in production, and neither says why.

> **Load this when:** rendering any image, adding an upload preview or thumbnail, or
> debugging a `/cdn-cgi/image/` 404.
> Canonical index: [CLAUDE.md](../../CLAUDE.md).

---

## Public images — `<NuxtImg>` at the edge

Anything in `public/`, in `content/blog/`, or on a marketing page. `@nuxt/image` is
configured with the `cloudflare` provider, so

```vue
<NuxtImg src="/og.png" width="640" sizes="sm:100vw md:640px" alt="…" />
```

renders `/cdn-cgi/image/w=640,f=auto,q=85/og.png`, and Cloudflare's edge resizes and
re-encodes it. No build step, no image binary in the bundle, srcset for free.

**`f=auto` is set globally in `nuxt.config.ts`, not per call site.** Forgetting it on one
`<NuxtImg>` would quietly ship a 400 kB PNG to a browser that would have taken a 40 kB
AVIF, and nothing would fail.

**Always pass `alt`.** `bun run test:a11y` runs axe over every public route and a missing
`alt` fails the build.

### The two things that surprise people

1. **`/cdn-cgi/image/` is a ZONE feature, not a Worker one.** It needs a custom domain
   with Images › Transformations enabled in the dashboard. On `*.workers.dev` the path
   404s. So does `bun dev` — which is why `nuxt.config.ts` carries a `$development`
   override swapping in the `none` provider. Local pages render originals. If you see
   broken images locally, check that override survived before checking anything else.
2. **It cannot serve anything behind a session.** See below.

---

## Private uploads — the Images binding, inside the Worker

Files uploaded through the R2 feature have no public URL. They are served by
[`server/api/files/[id].get.ts`](../../server/api/files/[id].get.ts), which is itself the
access-control boundary: `requireSubscription()`, then an ownership check scoped to
`userId`.

The edge cannot transform those. It resolves `/cdn-cgi/image/…/<src>` by **fetching the
source URL itself, with no cookie** — so against this endpoint it fetches a 401, and the
transform of a 401 is nothing at all. Making it work would mean giving the object a URL
that needs no session, which is precisely what that endpoint exists to deny.

So they transform **in the Worker, after the checks have passed**, via the `IMAGES`
binding. The order is the point: authorize, then resize.

```
GET /api/files/<id>?w=512&format=auto
```

| Param | Values | Default |
| --- | --- | --- |
| `w` | any integer; **snapped up** to the ladder in `IMAGE_WIDTHS` | none (original size) |
| `q` | 1–100 | 85 |
| `fit` | `scale-down` `contain` `cover` `crop` `pad` | `scale-down` |
| `format` | `auto` `webp` `avif` `jpeg` `png` | source format |

### Rules that are load-bearing

- **`w` snaps to a ladder rather than being honoured verbatim.** A free integer lets one
  authenticated account ask for 4,000 distinct widths of one file and get 4,000
  transforms and 4,000 cache entries out of it. The ladder bounds both, and it is the
  same ladder `screens` uses in `nuxt.config.ts` — change one, change the other.
- **The binding is feature-detected, and its absence serves the original.** Same
  convention as Resend and Turnstile: a fork that has not enabled Images gets full-size
  uploads, not a 500. Serving a bigger image than asked for is a performance regression;
  failing the request is a broken page.
- **A throwing transform falls through to the original too**, and logs
  `image_transform_failed`. Read that log before concluding transforms "work" — a
  misconfiguration looks exactly like success from the outside.
- **`Cache-Control: private`** on every transformed response. These bytes passed an
  ownership check scoped to one `userId`; a shared cache holding them would serve one
  customer's upload to the next request for the same URL.
- **`Vary: Accept` only when the format was negotiated.** Setting it for a format the
  caller named explicitly fragments the cache on a header that changed nothing.
- **SVG is never transformable.** It is not raster, resizing it is meaningless, and it is
  the one image type that can carry script.

### Where the code is

| File | What |
| --- | --- |
| [`server/utils/images.ts`](../../server/utils/images.ts) | The whole decision layer — parsing, snapping, negotiation, feature detection |
| [`server/api/files/[id].get.ts`](../../server/api/files/[id].get.ts) | The call site, after the access checks |
| [`test/images.test.ts`](../../test/images.test.ts) | Everything above, pinned |

The binding itself is not stubbed in tests. `images.input().transform().output()` is
Cloudflare's, and a hand-rolled fake would only assert that the fake behaves like the fake.
