// The port derivation behind parallel-worktree test runs.
//
// Worth testing rather than eyeballing: the failure mode of a bad port is a
// 300-second Playwright timeout that reads as "the app is broken", and the one
// property that actually matters — two checkouts never landing on the same
// port — is invisible until two agents run at once.

import { describe, expect, it } from 'vitest'

import { derivePort, playwrightPort, PORT_BASE, PORT_RANGE } from '../scripts/worktree-port'

const WORKTREE = '/Users/dev/app/.claude/worktrees'

describe('derivePort', () => {
  it('is deterministic — the same checkout gets the same port every run', () => {
    expect(derivePort(`${WORKTREE}/feat-billing`)).toBe(derivePort(`${WORKTREE}/feat-billing`))
  })

  it('stays inside the reserved range', () => {
    for (const path of [
      '/',
      '/a',
      `${WORKTREE}/x`,
      '/Users/someone/very/long/path/to/a/checkout',
    ]) {
      const port = derivePort(path)
      expect(port).toBeGreaterThanOrEqual(PORT_BASE)
      expect(port).toBeLessThan(PORT_BASE + PORT_RANGE)
    }
  })

  it('never returns 3000, which `bun run dev:app` owns', () => {
    expect(PORT_BASE).toBeGreaterThan(3000)
  })

  it('separates sibling worktrees — the property the whole thing exists for', () => {
    // Realistic sibling names: same parent, short suffix, one character apart
    // in places. A hash that only mixes the tail would collide on these.
    const names = [
      'saas-friction-rating-9f41b4',
      'saas-friction-rating-9f41b5',
      'template-design-scaffolding-92d516',
      'feat-magic-link',
      'feat-magic-links',
      'chore-license',
    ]
    const ports = new Set(names.map((name) => derivePort(`${WORKTREE}/${name}`)))
    expect(ports.size).toBe(names.length)
  })

  it('separates a worktree from its parent checkout', () => {
    expect(derivePort('/Users/dev/app')).not.toBe(derivePort(`${WORKTREE}/feat-x`))
  })
})

describe('playwrightPort', () => {
  it('prefers A11Y_PORT when it is a usable port', () => {
    expect(playwrightPort({ A11Y_PORT: '4200' }, '/anywhere')).toBe(4200)
  })

  it('falls back to the derived port when the override is missing or junk', () => {
    const derived = derivePort('/anywhere')
    for (const A11Y_PORT of [undefined, '', 'not-a-port', '0', '-1', '70000', '3.5']) {
      expect(playwrightPort({ A11Y_PORT }, '/anywhere')).toBe(derived)
    }
  })
})
