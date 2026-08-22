// Image transforms for the files feature.
//
// ── Why this is not @nuxt/image ─────────────────────────────────────────────
// @nuxt/image (configured in nuxt.config.ts) owns the PUBLIC half: marketing
// pages, blog images, anything under public/. It emits `/cdn-cgi/image/...`
// URLs, which Cloudflare's edge rewrites by fetching the source itself and
// transforming it before the request ever reaches this Worker.
//
// That mechanism cannot serve this feature. Every object here sits behind
// `requireSubscription()` plus an ownership check scoped to `userId`, and the
// edge's own fetch of the source URL carries no session cookie — so it gets a
// 401, and the transform of a 401 is nothing at all. Making it work would mean
// giving the object a URL that needs no session, which is the exact property
// server/api/files/[id].get.ts exists to deny.
//
// So private uploads transform INSIDE the Worker, after the access check has
// already passed, using the Images binding. The order is the whole point:
// authorize, then resize.
//
// ── Degrading when the binding is absent ────────────────────────────────────
// Unset binding = originals, same convention as Resend and Turnstile. A fork
// that has not enabled Images, an older wrangler, a trimmed wrangler.toml, or
// a non-Cloudflare preset all land in the same branch and get the full-size
// object rather than a 500. Serving a larger image than asked for is a
// performance regression; failing the request is a broken page.

import type { H3Event } from 'h3'

import { z } from 'zod'

/**
 * Formats worth transforming.
 *
 * SVG is deliberately absent. It is not a raster image, resizing it is
 * meaningless, and it is the one image type that can carry script — this app
 * already forces a download disposition on the types it will not render
 * inline (see dispositionForMimeType in server/utils/files.ts), and handing an
 * SVG to a transform pipeline is a second way to be wrong about that.
 */
const TRANSFORMABLE = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
])

/**
 * The only widths this endpoint will produce.
 *
 * Not a free integer, and that is a cost control rather than a style choice.
 * A caller is authenticated and paying, but `?w=` accepting any number lets
 * one account ask for 4,000 distinct widths of one file and get 4,000
 * transforms and 4,000 cache entries out of it. Snapping to a ladder bounds
 * both, and the ladder is the one `<NuxtImg>` generates srcset entries from,
 * so nothing real is asking for the widths in between.
 */
export const IMAGE_WIDTHS = [64, 128, 256, 384, 512, 768, 1024, 1536, 2048] as const

export const MAX_IMAGE_WIDTH = IMAGE_WIDTHS[IMAGE_WIDTHS.length - 1] as number

/** Snap a requested width UP to the next allowed rung, capped at the top. */
export function snapWidth(requested: number): number {
  for (const width of IMAGE_WIDTHS) {
    if (requested <= width) return width
  }
  return MAX_IMAGE_WIDTH
}

export const imageQuerySchema = z.object({
  w: z.coerce.number().int().positive().max(10_000).optional(),
  q: z.coerce.number().int().min(1).max(100).optional(),
  fit: z.enum(['scale-down', 'contain', 'cover', 'crop', 'pad']).optional(),
  format: z.enum(['auto', 'webp', 'avif', 'jpeg', 'png']).optional(),
})

export interface ImageRequest {
  width?: number
  quality: number
  fit: 'scale-down' | 'contain' | 'cover' | 'crop' | 'pad'
  /** null means "keep the source format". */
  format: 'image/webp' | 'image/avif' | 'image/jpeg' | 'image/png' | null
  /** True when `format` was negotiated from Accept and the response must Vary. */
  negotiated: boolean
}

/**
 * Turn the query string into a transform, or null when none was asked for.
 *
 * Returning null for "no modifiers" is what keeps the untouched path
 * byte-identical to what it was before this file existed: the route falls
 * through to `blob.serve()` and streams the object, rather than round-tripping
 * it through a transform that would only re-encode it.
 */
export function parseImageRequest(
  query: Record<string, unknown>,
  accept: string | undefined,
): ImageRequest | null {
  const parsed = imageQuerySchema.safeParse(query)
  if (!parsed.success) return null

  const { w, q, fit, format } = parsed.data
  if (w === undefined && q === undefined && format === undefined) return null

  let resolved: ImageRequest['format'] = null
  let negotiated = false
  if (format === 'auto') {
    // Cheapest first: AVIF beats WebP on size, and a browser that supports it
    // says so. Anything else keeps the source format rather than guessing.
    negotiated = true
    const header = accept ?? ''
    if (header.includes('image/avif')) resolved = 'image/avif'
    else if (header.includes('image/webp')) resolved = 'image/webp'
  } else if (format) {
    resolved = `image/${format}` as ImageRequest['format']
  }

  return {
    width: w === undefined ? undefined : snapWidth(w),
    quality: q ?? 85,
    fit: fit ?? 'scale-down',
    format: resolved,
    negotiated,
  }
}

export function isTransformableImage(mimeType: string | null | undefined): boolean {
  return TRANSFORMABLE.has((mimeType ?? '').toLowerCase())
}

/** The subset of the Images binding this file uses. */
export interface ImagesBindingLike {
  input(stream: ReadableStream): {
    transform(options: Record<string, unknown>): {
      output(options: { format: string; quality?: number }): Promise<{
        response(options?: { headers?: HeadersInit }): Response
      }>
    }
  }
}

/**
 * Pull the Images binding off the Worker env, or undefined when there isn't one.
 *
 * A runtime feature-detect for the same reason resolveNativeLimiter() in
 * server/utils/rate-limit.ts is one: `event.context.cloudflare` is typed as
 * `any`, so it typechecks whatever you write, and `typeof input === 'function'`
 * is the only thing that actually proves a binding is there.
 */
export function resolveImagesBinding(event: H3Event): ImagesBindingLike | undefined {
  const cloudflare: unknown = event.context.cloudflare
  if (!isRecord(cloudflare) || !isRecord(cloudflare.env)) return undefined

  const binding = cloudflare.env.IMAGES
  if (!isRecord(binding) || typeof binding.input !== 'function') return undefined
  return binding as unknown as ImagesBindingLike
}

/**
 * Run one transform. Throws only what the binding throws.
 *
 * The caller is expected to treat a throw as "serve the original" rather than
 * as a 500 — an unsupported or corrupt image must not turn a page into an
 * error, and ImagesError codes are not worth branching on here.
 */
export async function transformImage(
  images: ImagesBindingLike,
  body: ReadableStream,
  request: ImageRequest,
  sourceMimeType: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const transform: Record<string, unknown> = { fit: request.fit }
  if (request.width !== undefined) transform.width = request.width

  const result = await images
    .input(body)
    .transform(transform)
    .output({ format: request.format ?? sourceMimeType, quality: request.quality })

  // Headers go through the binding's own `response()` rather than
  // setHeader(event, ...): this handler returns a Response object, and h3 uses
  // that object's headers rather than merging the ones set on the event.
  return result.response({ headers: transformHeaders(request, headers) })
}

/**
 * `private` is not decoration. Every byte here passed an ownership check
 * scoped to one `userId`, so a shared cache holding it would serve one
 * customer's upload to the next request for the same URL.
 *
 * `Vary: Accept` is only set when the format was actually negotiated. Setting
 * it unconditionally would fragment the cache by a header that changed nothing
 * about the response.
 */
function transformHeaders(
  request: ImageRequest,
  extra: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Cache-Control': 'private, max-age=3600',
    ...extra,
  }
  if (request.negotiated) headers.Vary = 'Accept'
  return headers
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
