// Account provisioning, against a real D1 inside workerd.
//
// The cases that matter aren't "does an insert work" — they're the ones that
// decide whether two sign-ins are the same person: casing, a second provider on
// the same address, and a profile that changed since last time.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import * as schema from '../server/db/schema'
import { normalizeEmail, upsertOAuthUser } from '../server/utils/users'

const db = drizzle(env.DB, { schema })

beforeEach(async () => {
  await env.DB.exec('DELETE FROM entitlements')
  await env.DB.exec('DELETE FROM users')
})

describe('normalizeEmail', () => {
  it('lowercases and trims, because the unique index does neither', () => {
    expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com')
  })
})

describe('upsertOAuthUser', () => {
  it('creates an account on first sign-in', async () => {
    const { user, created } = await upsertOAuthUser(db, {
      provider: 'github',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      avatarUrl: 'https://example.com/a.png',
    })

    expect(created).toBe(true)
    expect(user.email).toBe('ada@example.com')
    expect(user.name).toBe('Ada Lovelace')
    expect(user.provider).toBe('github')
    expect(user.role).toBe('user')
    expect(user.lastLoginAt).toBeInstanceOf(Date)
  })

  it('returns the same account on a second sign-in', async () => {
    const first = await upsertOAuthUser(db, {
      provider: 'github',
      email: 'ada@example.com',
      name: 'Ada',
    })
    const second = await upsertOAuthUser(db, {
      provider: 'github',
      email: 'ada@example.com',
      name: 'Ada',
    })

    expect(second.created).toBe(false)
    expect(second.user.id).toBe(first.user.id)

    const rows = await db.select().from(schema.users)
    expect(rows).toHaveLength(1)
  })

  it('treats a different-cased address as the same account', async () => {
    const first = await upsertOAuthUser(db, { provider: 'github', email: 'ada@example.com' })
    const second = await upsertOAuthUser(db, { provider: 'github', email: 'ADA@Example.com' })

    expect(second.created).toBe(false)
    expect(second.user.id).toBe(first.user.id)
  })

  it('links a second provider to the existing account, not a duplicate', async () => {
    // The whole point of keying on email: sign in with GitHub today, Google
    // tomorrow, keep the same subscription.
    const github = await upsertOAuthUser(db, { provider: 'github', email: 'ada@example.com' })
    const google = await upsertOAuthUser(db, { provider: 'google', email: 'ada@example.com' })

    expect(google.user.id).toBe(github.user.id)
    // `provider` records who created the account and is not rewritten — it's
    // support context ("which button did I press the first time?"), not state.
    expect(google.user.provider).toBe('github')
  })

  it('refreshes name and avatar from the provider', async () => {
    await upsertOAuthUser(db, {
      provider: 'github',
      email: 'ada@example.com',
      name: 'Ada',
      avatarUrl: 'https://example.com/old.png',
    })
    const { user } = await upsertOAuthUser(db, {
      provider: 'github',
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      avatarUrl: 'https://example.com/new.png',
    })

    expect(user.name).toBe('Ada Lovelace')
    expect(user.avatarUrl).toBe('https://example.com/new.png')
  })

  it('keeps the old avatar when the provider sends none', async () => {
    await upsertOAuthUser(db, {
      provider: 'github',
      email: 'ada@example.com',
      avatarUrl: 'https://example.com/a.png',
    })
    const { user } = await upsertOAuthUser(db, { provider: 'google', email: 'ada@example.com' })

    expect(user.avatarUrl).toBe('https://example.com/a.png')
  })

  it('never lets a provider set the role', async () => {
    // An identity provider proves who you are, not what you're allowed to do.
    // Promote someone in the DB and a later sign-in must not demote them.
    const { user } = await upsertOAuthUser(db, { provider: 'github', email: 'ada@example.com' })
    await db.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, user.id))

    const again = await upsertOAuthUser(db, { provider: 'github', email: 'ada@example.com' })
    expect(again.user.role).toBe('admin')
  })

  it('falls back to the local-part when a provider sends no name', async () => {
    // GitHub returns name: null for anyone who never filled in their profile.
    const { user } = await upsertOAuthUser(db, { provider: 'github', email: 'ada@example.com' })
    expect(user.name).toBe('ada')
  })
})
