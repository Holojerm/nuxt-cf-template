// The rate-limit namespace pair `bun run rename` hands a fork.
//
// The regression worth guarding: three forks shipped the template's own
// "1001" and shared one set of sign-in counters on the account.

import { describe, expect, it } from 'vitest'

import {
  NAMESPACE_MAX,
  NAMESPACE_MIN,
  deriveNamespaceIds,
  rewriteNamespaceIds,
} from '../scripts/ratelimit-namespace'

describe('deriveNamespaceIds', () => {
  it('is stable for a name', () => {
    expect(deriveNamespaceIds('acme-widgets')).toEqual(deriveNamespaceIds('acme-widgets'))
  })

  it('stays inside the documented range and never produces the template pair', () => {
    for (const name of ['sinew', 'pocket-film-school', 'drawthesystem-cloud', 'a', 'zz-top-9']) {
      const { production, preview } = deriveNamespaceIds(name)
      expect(production).toBeGreaterThanOrEqual(NAMESPACE_MIN)
      expect(preview).toBeLessThanOrEqual(NAMESPACE_MAX)
      expect([1001, 1002]).not.toContain(production)
      expect([1001, 1002]).not.toContain(preview)
    }
  })

  it('makes preview production + 1, on an even production id so pairs never overlap', () => {
    const { production, preview } = deriveNamespaceIds('sinew')
    expect(preview).toBe(production + 1)
    expect(production % 2).toBe(0)
  })

  it('gives different names different pairs', () => {
    const seen = new Set(
      ['sinew', 'pocket-film-school', 'drawthesystem-cloud', 'my-app'].map(
        (name) => deriveNamespaceIds(name).production,
      ),
    )
    expect(seen.size).toBe(4)
  })
})

describe('rewriteNamespaceIds', () => {
  const toml = `
[[ratelimits]]
name = "RATE_LIMITER"
namespace_id = "1001"
simple = { limit = 30, period = 60 }

[[env.preview.d1_databases]]
binding = "DB"

[[env.preview.ratelimits]]
name = "RATE_LIMITER"
namespace_id = "1002"
simple = { limit = 30, period = 60 }
`

  it('rewrites the production and preview blocks with their own ids', () => {
    const { toml: out, replaced } = rewriteNamespaceIds(toml, { production: 4242, preview: 4243 })
    expect(replaced).toBe(2)
    expect(out).toContain('namespace_id = "4242"')
    expect(out).toContain('namespace_id = "4243"')
    expect(out).not.toContain('"1001"')
    expect(out).not.toContain('"1002"')
  })

  it('leaves every other line byte-for-byte alone', () => {
    const { toml: out } = rewriteNamespaceIds(toml, { production: 4242, preview: 4243 })
    expect(out.replace(/namespace_id = "\d+"/g, 'X')).toBe(
      toml.replace(/namespace_id = "\d+"/g, 'X'),
    )
  })

  it('touches nothing outside a ratelimits block', () => {
    const other = '[[kv_namespaces]]\nbinding = "KV"\nnamespace_id = "abc"\n'
    const { toml: out, replaced } = rewriteNamespaceIds(other, { production: 1, preview: 2 })
    expect(replaced).toBe(0)
    expect(out).toBe(other)
  })
})
