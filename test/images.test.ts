// The image-transform decision layer — everything that runs BEFORE the Images
// binding is touched, and therefore everything that can be tested without one.
//
// The binding itself is not stubbed here. `images.input(stream).transform().output()`
// is Cloudflare's, and a hand-rolled fake of it would assert that the fake
// behaves like the fake. What is worth pinning down is the logic this repo
// owns and that fails silently when wrong:
//
//   1. `?w=` snaps to the ladder rather than being honoured verbatim — the
//      cost control described in server/utils/images.ts.
//   2. No modifiers means NO transform, so the untouched path stays a plain
//      stream of the original object.
//   3. `format=auto` reads Accept, prefers AVIF, and marks the response as
//      needing `Vary: Accept` — and does NOT mark it when the format was named
//      explicitly.
//   4. SVG is never transformable, whatever the query says.
//   5. A junk query degrades to "no transform", never to a 500.

import { describe, expect, it } from 'vitest'

import {
  IMAGE_WIDTHS,
  MAX_IMAGE_WIDTH,
  isTransformableImage,
  parseImageRequest,
  snapWidth,
} from '../server/utils/images'

describe('snapWidth', () => {
  it('rounds up to the next rung rather than honouring the request', () => {
    expect(snapWidth(1)).toBe(64)
    expect(snapWidth(65)).toBe(128)
    expect(snapWidth(400)).toBe(512)
  })

  it('returns a rung exactly when one is asked for', () => {
    for (const width of IMAGE_WIDTHS) expect(snapWidth(width)).toBe(width)
  })

  it('caps at the top rung, so no single request can ask for an arbitrary size', () => {
    expect(snapWidth(4096)).toBe(MAX_IMAGE_WIDTH)
    expect(snapWidth(9_999)).toBe(MAX_IMAGE_WIDTH)
  })
})

describe('parseImageRequest', () => {
  it('returns null when nothing was asked for, so the original streams untouched', () => {
    expect(parseImageRequest({}, undefined)).toBeNull()
    // `fit` alone is not a request to transform — it only says how to, and
    // there is no size to fit to.
    expect(parseImageRequest({ fit: 'cover' }, undefined)).toBeNull()
  })

  it('snaps the width it returns', () => {
    expect(parseImageRequest({ w: '300' }, undefined)?.width).toBe(384)
  })

  it('defaults quality and fit rather than leaving them undefined', () => {
    const request = parseImageRequest({ w: '256' }, undefined)
    expect(request?.quality).toBe(85)
    expect(request?.fit).toBe('scale-down')
  })

  it('prefers AVIF over WebP when the browser accepts both', () => {
    const request = parseImageRequest({ format: 'auto' }, 'image/avif,image/webp,*/*')
    expect(request?.format).toBe('image/avif')
    expect(request?.negotiated).toBe(true)
  })

  it('falls back to WebP, then to the source format', () => {
    expect(parseImageRequest({ format: 'auto' }, 'image/webp,*/*')?.format).toBe('image/webp')
    // No modern format on offer: keep the source rather than guessing.
    expect(parseImageRequest({ format: 'auto' }, 'image/png,*/*')?.format).toBeNull()
    expect(parseImageRequest({ format: 'auto' }, undefined)?.format).toBeNull()
  })

  it('does not mark an explicitly named format as negotiated', () => {
    // The distinction drives `Vary: Accept`. Setting it for a format the caller
    // named would fragment the cache on a header that changed nothing.
    const request = parseImageRequest({ format: 'webp' }, 'image/avif')
    expect(request?.format).toBe('image/webp')
    expect(request?.negotiated).toBe(false)
  })

  it('degrades a junk query to no transform instead of throwing', () => {
    expect(parseImageRequest({ w: 'huge' }, undefined)).toBeNull()
    expect(parseImageRequest({ q: '0' }, undefined)).toBeNull()
    expect(parseImageRequest({ q: '101' }, undefined)).toBeNull()
    expect(parseImageRequest({ format: 'bmp' }, undefined)).toBeNull()
    expect(parseImageRequest({ fit: 'squish' }, undefined)).toBeNull()
    expect(parseImageRequest({ w: '-10' }, undefined)).toBeNull()
  })
})

describe('isTransformableImage', () => {
  it('accepts the raster types this app stores', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']) {
      expect(isTransformableImage(type)).toBe(true)
    }
  })

  it('is case-insensitive, because a declared mime type is caller-supplied', () => {
    expect(isTransformableImage('IMAGE/JPEG')).toBe(true)
  })

  it('never transforms SVG — it is not raster and it can carry script', () => {
    expect(isTransformableImage('image/svg+xml')).toBe(false)
  })

  it('rejects non-images and missing types', () => {
    expect(isTransformableImage('application/pdf')).toBe(false)
    expect(isTransformableImage(null)).toBe(false)
    expect(isTransformableImage(undefined)).toBe(false)
  })
})
