// GET /manifest.webmanifest's builder.
//
// The route itself (server/routes/manifest.webmanifest.get.ts) is not tested
// here — it's a thin wrapper around buildManifest(), and importing a route
// file directly would hit `defineEventHandler`/`useRuntimeConfig` before a
// single assertion ran, since those are Nitro auto-imports that only exist
// after Nuxt's build-time transform, not under plain `vitest-pool-workers`.
// server/utils/manifest.ts takes every value as a parameter for exactly this
// reason — see its header comment.
//
// What's worth testing here is `app.baseURL` reaching every URL-shaped field.
// A fork's default baseURL is `/`, so this bug is invisible until someone
// deploys under a sub-path — at which point `scope` silently excludes the
// app it's supposed to scope, and both icons 404.

import { describe, expect, it } from 'vitest'

import { buildManifest, withBase } from '../server/utils/manifest'

describe('withBase', () => {
  it('leaves a root deploy alone', () => {
    expect(withBase('/', '/')).toBe('/')
    expect(withBase('/', '/icon-192.png')).toBe('/icon-192.png')
  })

  it('prefixes a sub-path deploy without doubling the slash', () => {
    expect(withBase('/app/', '/')).toBe('/app/')
    expect(withBase('/app/', '/icon-192.png')).toBe('/app/icon-192.png')
  })

  it('tolerates a baseURL with no trailing slash', () => {
    expect(withBase('/app', '/icon-512.png')).toBe('/app/icon-512.png')
  })
})

describe('buildManifest', () => {
  const base = { appName: 'Quarry', appDescription: 'A test app.' }

  it('scopes to root by default', () => {
    const manifest = buildManifest({ baseURL: '/', ...base })
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect(manifest.icons.map((icon) => icon.src)).toEqual(['/icon-192.png', '/icon-512.png'])
  })

  it('carries a sub-path baseURL onto start_url, scope, and both icon srcs', () => {
    const manifest = buildManifest({ baseURL: '/app/', ...base })
    expect(manifest.start_url).toBe('/app/')
    expect(manifest.scope).toBe('/app/')
    expect(manifest.icons.map((icon) => icon.src)).toEqual([
      '/app/icon-192.png',
      '/app/icon-512.png',
    ])
  })

  it('reads name/description from config, not a hardcoded default', () => {
    const manifest = buildManifest({
      baseURL: '/',
      appName: 'Custom App',
      appDescription: 'Custom description.',
    })
    expect(manifest.name).toBe('Custom App')
    expect(manifest.short_name).toBe('Custom App')
    expect(manifest.description).toBe('Custom description.')
  })

  it('both icons declare "any maskable" — they were generated safe for either', () => {
    const manifest = buildManifest({ baseURL: '/', ...base })
    for (const icon of manifest.icons) {
      expect(icon.purpose).toBe('any maskable')
      expect(icon.type).toBe('image/png')
    }
  })

  it('theme/background colors come from the generated brand palette, not a literal here', () => {
    const manifest = buildManifest({ baseURL: '/', ...base })
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/)
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/)
  })
})
