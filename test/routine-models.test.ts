// Routine model tiers: the frontmatter rule, the table rule, and picking the
// newest model from frontier-terminal's price catalog.

import { describe, expect, it } from 'vitest'

import {
  behind,
  newestByTier,
  type PriceRow,
  routineModelProblem,
  tableProblems,
} from '../scripts/lib/routine-models'

const row = (model_slug: string, removed = false, provider = 'anthropic'): PriceRow => ({
  provider,
  model_slug,
  removed,
})

describe('routineModelProblem', () => {
  it('accepts a tier, with or without a trailing comment', () => {
    expect(routineModelProblem('opus')).toBeNull()
    expect(routineModelProblem('sonnet    # a tier')).toBeNull()
  })

  it('names the tier to write instead of a pinned ID', () => {
    expect(routineModelProblem('claude-sonnet-5')).toContain('write `model: sonnet`')
  })

  it('refuses a missing line and an unknown value', () => {
    expect(routineModelProblem(undefined)).toBe('no `model:` line')
    expect(routineModelProblem('gpt-5')).toContain('is not a tier')
  })
})

describe('tableProblems', () => {
  const good = {
    tiers: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' },
  }

  it('passes a full table', () => {
    expect(tableProblems(good)).toEqual([])
  })

  it('catches an ID filed under the wrong tier, a missing tier and an unknown one', () => {
    const problems = tableProblems({
      tiers: { opus: 'claude-sonnet-5-5', sonnet: 'claude-sonnet-5-5', fable: 'claude-fable-5-2' },
    })
    expect(problems.join('\n')).toMatch(/tier `opus` maps to `claude-sonnet-5-5`/)
    expect(problems.join('\n')).toMatch(/tier `haiku` has no model ID/)
    expect(problems.join('\n')).toMatch(/unknown tier `fable`/)
  })
})

describe('newestByTier', () => {
  it('compares versions numerically, not as strings', () => {
    const rows = [
      row('claude-opus-5'),
      row('claude-opus-5-5'),
      row('claude-opus-4-8'),
      row('claude-opus-10'),
    ]
    expect(newestByTier(rows).opus).toBe('claude-opus-10')
  })

  it('treats a bare major as minor 0', () => {
    expect(newestByTier([row('claude-sonnet-6'), row('claude-sonnet-5-5')]).sonnet).toBe(
      'claude-sonnet-6',
    )
  })

  it('never picks a removed row, another provider, or a decorated slug', () => {
    const rows = [
      row('claude-haiku-5-5'),
      row('claude-haiku-6', true),
      row('claude-haiku-7', false, 'openrouter'),
      row('claude-haiku-6-(for-prompts-up-to-100,000-tokens)'),
    ]
    expect(newestByTier(rows).haiku).toBe('claude-haiku-5-5')
  })
})

describe('behind', () => {
  const table = {
    source: 'https://example.test',
    tiers: { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' },
  } as const

  it('reports only tiers where the source is strictly newer', () => {
    expect(
      behind(
        { ...table, tiers: { ...table.tiers } },
        { opus: 'claude-opus-6', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5' },
      ),
    ).toEqual([{ tier: 'opus', current: 'claude-opus-5-5', newest: 'claude-opus-6' }])
  })
})
