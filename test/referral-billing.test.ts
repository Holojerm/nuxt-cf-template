// When the referral loop reacts to a Paddle event. The decision is the one the
// webhook route made inline before billing moved into a layer; the reward and
// the cascade themselves are tested in test/referral.test.ts.

import { describe, expect, it, vi } from 'vitest'

import type { BillingOutcomeContext } from '../server/utils/billing-outcome'
import { createReferralOutcomeHandler } from '../server/utils/referral-billing'

function setup() {
  const reward = vi.fn(async () => {})
  const cascade = vi.fn(async () => {})
  const handler = createReferralOutcomeHandler({
    reward: reward as never,
    cascade: cascade as never,
  })
  const run = (outcome: unknown, dataId = 'txn_or_sub_1') =>
    handler({
      db: {},
      event: { data: { id: dataId } },
      outcome,
    } as unknown as BillingOutcomeContext)
  return { reward, cascade, run }
}

describe('referral reward', () => {
  it('pays on a pass, keyed on the transaction a refund will name', async () => {
    const { reward, run } = setup()
    await run({ kind: 'pass', userId: 'u1', granted: true }, 'txn_1')
    expect(reward).toHaveBeenCalledWith({}, 'u1', { earnedFromRef: 'txn_1' })
  })

  it.each([null, 'trialing'])(
    'pays on a subscription going active from %s, keyed on its FIRST transaction',
    async (previousStatus) => {
      const { reward, run } = setup()
      await run(
        {
          kind: 'subscription',
          userId: 'u1',
          status: 'active',
          previousStatus,
          firstTransactionId: 'txn_first',
        },
        'sub_1',
      )
      expect(reward).toHaveBeenCalledWith({}, 'u1', { earnedFromRef: 'txn_first' })
    },
  )

  it('falls back to the subscription id when Paddle never sent a first transaction', async () => {
    const { reward, run } = setup()
    await run(
      {
        kind: 'subscription',
        userId: 'u1',
        status: 'active',
        previousStatus: null,
        firstTransactionId: null,
      },
      'sub_1',
    )
    expect(reward).toHaveBeenCalledWith({}, 'u1', { earnedFromRef: 'sub_1' })
  })

  it.each([
    ['a dunning recovery', 'past_due'],
    ['a resume', 'paused'],
    ['a renewal', 'active'],
  ])('does not pay on %s', async (_name, previousStatus) => {
    const { reward, run } = setup()
    await run({
      kind: 'subscription',
      userId: 'u1',
      status: 'active',
      previousStatus,
      firstTransactionId: null,
    })
    expect(reward).not.toHaveBeenCalled()
  })

  it('does not pay when a subscription is not active (past_due, canceled)', async () => {
    const { reward, run } = setup()
    await run({
      kind: 'subscription',
      userId: 'u1',
      status: 'past_due',
      previousStatus: null,
      firstTransactionId: null,
    })
    expect(reward).not.toHaveBeenCalled()
  })

  it.each([
    { kind: 'ignored', reason: 'duplicate_event' },
    { kind: 'ignored', reason: 'unknown_user' },
    { kind: 'adjustment', action: 'refund', result: { outcome: 'revoked' } },
  ])('does not pay on $kind $reason', async (outcome) => {
    const { reward, run } = setup()
    await run(outcome)
    expect(reward).not.toHaveBeenCalled()
  })
})

describe('referral clawback paperwork', () => {
  it('records the cascade for an adjustment, and only for an adjustment', async () => {
    const { cascade, run } = setup()
    const result = { outcome: 'revoked', derived: [] }
    await run({ kind: 'adjustment', action: 'refund', result })
    expect(cascade).toHaveBeenCalledWith({}, result)

    cascade.mockClear()
    await run({ kind: 'pass', userId: 'u1', granted: true })
    expect(cascade).not.toHaveBeenCalled()
  })
})
