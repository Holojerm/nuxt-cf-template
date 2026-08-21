// The portless hostname each checkout gets.
//
// The regression worth guarding is the last one: portless's own branch-derived
// prefix collided in three separate ways, and all three are silent — two
// worktrees just quietly serve on one hostname and the second `bun dev` either
// takes the route over or refuses it.

import { describe, expect, it } from 'vitest'

import { devAppName, sanitizeLabel } from '../scripts/worktree-name'

describe('sanitizeLabel', () => {
  it('lowercases and hyphenates', () => {
    expect(sanitizeLabel('Feat/Magic Link')).toBe('feat-magic-link')
  })

  it('trims leading and trailing separators', () => {
    expect(sanitizeLabel('--wip--')).toBe('wip')
    expect(sanitizeLabel('_private_')).toBe('private')
  })

  it('collapses punctuation rather than dropping it, so near-identical names stay distinct', () => {
    expect(sanitizeLabel('feat.billing')).not.toBe(sanitizeLabel('featbilling'))
  })

  it('respects the 63-character DNS label limit and never ends on a hyphen', () => {
    const label = sanitizeLabel(`${'a'.repeat(62)}--tail`)
    expect(label.length).toBeLessThanOrEqual(63)
    expect(label.endsWith('-')).toBe(false)
  })

  it('returns empty for a name with nothing usable in it', () => {
    expect(sanitizeLabel('///')).toBe('')
  })
})

describe('devAppName', () => {
  it('leaves the main checkout on the bare configured name', () => {
    expect(devAppName('my-app', null)).toBe('my-app')
  })

  it('prefixes a linked worktree with its directory', () => {
    expect(devAppName('my-app', 'feat-billing')).toBe('feat-billing.my-app')
  })

  it('falls back to the bare name rather than emit a leading dot', () => {
    expect(devAppName('my-app', '///')).toBe('my-app')
  })

  it('separates every case that portless’ branch prefix collapsed', () => {
    // Each of these previously resolved to a bare `my-app.localhost`, or to the
    // same host as a sibling:
    //   - a worktree sitting on main/master (portless skips default branches)
    //   - a detached-HEAD worktree (branch reads as "HEAD", also skipped)
    //   - two branches sharing a last path segment (feat/x vs claude/x)
    const names = [
      devAppName('my-app', null), // main checkout
      devAppName('my-app', 'wt-on-main'), // worktree checked out on main
      devAppName('my-app', 'wt-detached'), // detached HEAD
      devAppName('my-app', 'wt-feat-magic-link'), // feat/magic-link
      devAppName('my-app', 'wt-claude-magic-link'), // claude/magic-link
    ]
    expect(new Set(names).size).toBe(names.length)
  })

  it('does not depend on the branch, so the URL survives a branch switch', () => {
    // The whole reason the worktree directory is the key: it does not move.
    expect(devAppName('my-app', 'saas-friction-9f41b4')).toBe(
      devAppName('my-app', 'saas-friction-9f41b4'),
    )
  })
})
