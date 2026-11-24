// Which account an OAuth sign-in lands on, and linking a provider to the
// signed-in account, against real D1 in workerd. Apple has no credentials in
// the template, so every Apple case here is a faked provider result: the
// profile its handler would build from a verified id_token.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { deleteAccount, exportAccount } from '../server/utils/account'
import {
  attachLinkedIdentity,
  signLinkIntent,
  verifyLinkIntent,
} from '../server/utils/identity-link'
import { signInOAuthUser } from '../server/utils/oauth-sign-in'
import { findIdentityOwner, linkIdentity } from '../server/utils/user-identities'

const db = drizzle(env.DB, { schema })
const PASSWORD = 'test-session-password-of-reasonable-length'
const RELAY = 'x7k2@privaterelay.appleid.com'

const google = (email = 'ada@example.com', sub = 'g-123') => ({
  provider: 'google',
  subject: sub,
  email,
  name: 'Ada Lovelace',
})
const apple = (email = RELAY, sub = 'apple-001') => ({
  provider: 'apple',
  subject: sub,
  email,
  name: null,
})

async function signIn(profile: Parameters<typeof signInOAuthUser>[1]['profile'], verified = true) {
  const outcome = await signInOAuthUser(db, { profile, emailVerified: verified, attribution: null })
  if ('refused' in outcome) throw new Error(`refused: ${outcome.refused}`)
  return outcome
}

const identitiesOf = (userId: string) =>
  db.query.userIdentities.findMany({ where: eq(schema.userIdentities.userId, userId) })

beforeEach(async () => {
  await env.DB.exec('DELETE FROM user_identities')
  await env.DB.exec('DELETE FROM audit_log')
  await env.DB.exec('DELETE FROM entitlements')
  await env.DB.exec('DELETE FROM users')
})

describe('signInOAuthUser', () => {
  it('creates an account on first sign-in and records the identity', async () => {
    const first = await signIn(google())
    expect(first.matchedBy).toBe('created')
    expect(await findIdentityOwner(db, 'google', 'g-123')).toBe(first.user.id)
  })

  it('matches on (provider, subject) before the address the provider reports', async () => {
    const first = await signIn(google())
    // The Google account's address changed; the subject did not.
    const again = await signIn(google('ada@new.example'))
    expect(again).toMatchObject({ matchedBy: 'identity', created: false })
    expect(again.user.id).toBe(first.user.id)
    expect(again.user.email).toBe('ada@example.com')
  })

  it('matches a verified email to an existing account and records the identity on it', async () => {
    const viaGoogle = await signIn(google())
    const viaGitHub = await signIn({ provider: 'github', subject: '42', email: 'ADA@example.com' })
    expect(viaGitHub).toMatchObject({ matchedBy: 'email', created: false })
    expect(viaGitHub.user.id).toBe(viaGoogle.user.id)
    expect(await findIdentityOwner(db, 'github', '42')).toBe(viaGoogle.user.id)
  })

  it('never matches, creates or records on an unverified email', async () => {
    const existing = await signIn(google())
    const outcome = await signInOAuthUser(db, {
      profile: { provider: 'github', subject: '99', email: 'ada@example.com' },
      emailVerified: false,
    })
    expect(outcome).toEqual({ refused: 'unverified_email' })
    expect(await findIdentityOwner(db, 'github', '99')).toBeNull()
    expect(await identitiesOf(existing.user.id)).toHaveLength(1)
    expect(await db.query.users.findMany()).toHaveLength(1)
  })

  it('refuses a profile with no address and no linked identity', async () => {
    const outcome = await signInOAuthUser(db, {
      profile: { provider: 'apple', subject: 'apple-x', email: '' },
      emailVerified: true,
    })
    expect(outcome).toEqual({ refused: 'no_email' })
  })

  it('lets a linked identity in by subject even when this address is unverified', async () => {
    const first = await signIn(google())
    const again = await signIn(google('other@example.com'), false)
    expect(again.user.id).toBe(first.user.id)
  })

  it('gives a first Apple sign-in with a hidden address a new account', async () => {
    const viaGoogle = await signIn(google())
    const viaApple = await signIn(apple())
    expect(viaApple.matchedBy).toBe('created')
    expect(viaApple.user.id).not.toBe(viaGoogle.user.id)
    expect(viaApple.user.email).toBe(RELAY)
  })

  it('keeps the name when Apple sends none on a later sign-in', async () => {
    const first = await signIn({ ...apple(), name: 'Grace Hopper' })
    const again = await signIn(apple())
    expect(again.user.id).toBe(first.user.id)
    expect(again.user.name).toBe('Grace Hopper')
  })

  it('without a subject (magic link) is the verified-email path alone', async () => {
    const outcome = await signIn({ provider: 'email', email: 'ada@example.com' })
    expect(outcome.matchedBy).toBe('created')
    expect(await identitiesOf(outcome.user.id)).toHaveLength(0)
  })
})

describe('linking a provider to the signed-in account', () => {
  const intentFor = (userId: string, provider = 'apple') => ({
    userId,
    provider,
    issuedAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  })

  it('attaches the identity to the intent user, and Apple then signs in to that account', async () => {
    const owner = await signIn(google())
    const ref = { provider: 'apple', subject: 'apple-001', email: RELAY }
    expect(await attachLinkedIdentity(db, intentFor(owner.user.id), ref)).toEqual({
      outcome: 'linked',
    })
    const viaApple = await signIn(apple())
    expect(viaApple).toMatchObject({ matchedBy: 'identity' })
    expect(viaApple.user.id).toBe(owner.user.id)
  })

  it('refuses an identity that already signs in to another account, and changes nothing', async () => {
    const appleAccount = await signIn(apple())
    const other = await signIn(google())
    const ref = { provider: 'apple', subject: 'apple-001', email: RELAY }
    expect(await attachLinkedIdentity(db, intentFor(other.user.id), ref)).toEqual({
      outcome: 'taken',
    })
    expect(await findIdentityOwner(db, 'apple', 'apple-001')).toBe(appleAccount.user.id)
  })

  it('reports a second link of the same identity as already linked', async () => {
    const owner = await signIn(google())
    expect(await linkIdentity(db, owner.user.id, { provider: 'google', subject: 'g-123' })).toEqual(
      { outcome: 'already_linked' },
    )
  })

  it('refuses when the browser now holds a different session user', async () => {
    const owner = await signIn(google())
    const ref = { provider: 'apple', subject: 'apple-001' }
    expect(await attachLinkedIdentity(db, intentFor(owner.user.id), ref, 'someone-else')).toEqual({
      outcome: 'expired',
    })
    expect(await findIdentityOwner(db, 'apple', 'apple-001')).toBeNull()
  })

  it('refuses when the starting session was revoked since', async () => {
    const owner = await signIn(google())
    const intent = { ...intentFor(owner.user.id), issuedAt: 1000 }
    await db
      .update(schema.users)
      .set({ sessionsInvalidBefore: new Date() })
      .where(eq(schema.users.id, owner.user.id))
    const ref = { provider: 'apple', subject: 'apple-001' }
    expect(await attachLinkedIdentity(db, intent, ref)).toEqual({ outcome: 'expired' })
  })
})

describe('the link-intent cookie value', () => {
  const intent = { userId: 'u1', provider: 'apple', issuedAt: 1, expiresAt: 2_000_000_000 }

  it('round-trips for its provider only', async () => {
    const raw = await signLinkIntent(PASSWORD, intent)
    expect(await verifyLinkIntent(PASSWORD, raw, 'apple', 0)).toEqual(intent)
    expect(await verifyLinkIntent(PASSWORD, raw, 'google', 0)).toBeNull()
  })

  it('rejects an edited body, another key, and an expired intent', async () => {
    const raw = await signLinkIntent(PASSWORD, intent)
    const [, signature] = raw.split('.')
    const forged = await signLinkIntent(PASSWORD, { ...intent, userId: 'victim' })
    const [forgedBody] = forged.split('.')
    expect(await verifyLinkIntent(PASSWORD, `${forgedBody}.${signature}`, 'apple', 0)).toBeNull()
    expect(await verifyLinkIntent('another-password', raw, 'apple', 0)).toBeNull()
    expect(await verifyLinkIntent(PASSWORD, raw, 'apple', 2_000_000_000_000)).toBeNull()
    expect(await verifyLinkIntent(PASSWORD, 'garbage', 'apple', 0)).toBeNull()
    expect(await verifyLinkIntent('', raw, 'apple', 0)).toBeNull()
  })
})

describe('deletion and export', () => {
  it('lists every linked identity in the export', async () => {
    const owner = await signIn(google())
    await linkIdentity(db, owner.user.id, { provider: 'apple', subject: 'apple-001', email: RELAY })
    const result = await exportAccount(db, owner.user.id)
    expect(result?.signInMethods).toEqual([
      {
        provider: 'google',
        subject: 'g-123',
        email: 'ada@example.com',
        linkedAt: expect.any(String),
      },
      { provider: 'apple', subject: 'apple-001', email: RELAY, linkedAt: expect.any(String) },
    ])
  })

  it('deletes the rows with the account, so the identity cannot sign in to the tombstone', async () => {
    const owner = await signIn(google())
    const bystander = await signIn(apple('grace@example.com', 'apple-002'))
    expect(await deleteAccount(db, owner.user.id)).toEqual({ outcome: 'deleted' })

    expect(await identitiesOf(owner.user.id)).toHaveLength(0)
    expect(await identitiesOf(bystander.user.id)).toHaveLength(1)
    const audit = await db.query.auditLog.findFirst({
      where: eq(schema.auditLog.action, 'account.deleted'),
    })
    expect(audit?.metadata).toMatchObject({ identitiesCount: 1 })

    const again = await signIn(google())
    expect(again.matchedBy).toBe('created')
    expect(again.user.id).not.toBe(owner.user.id)
  })
})
