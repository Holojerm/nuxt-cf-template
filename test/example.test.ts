// Demonstrates the testing pattern: tests run inside `workerd` (the same
// runtime Cloudflare uses in production) with real D1, KV, and R2 bindings
// available via the `cloudflare:test` import.
//
// Delete this file or replace with your own once you have real tests.

import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('Cloudflare bindings in tests', () => {
  it('D1 is reachable via env.DB', async () => {
    const result = await env.DB.prepare('SELECT 1 AS n').first<{ n: number }>()
    expect(result?.n).toBe(1)
  })

  it('KV is reachable via env.KV', async () => {
    await env.KV.put('hello', 'world')
    expect(await env.KV.get('hello')).toBe('world')
  })

  it('R2 is reachable via env.BLOB', async () => {
    await env.BLOB.put('greeting.txt', 'hi')
    const obj = await env.BLOB.get('greeting.txt')
    expect(await obj?.text()).toBe('hi')
  })
})
