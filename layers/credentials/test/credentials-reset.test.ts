// Password reset and change, against real D1 and core's real session guard: a
// reset must end every older session, fire the app's hook in the same batch,
// and leave the session issued right after it alive.

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { checkSession } from '~~/server/utils/session-guard'
import {
  clearCredentialsHooksForTest,
  onCredentialsPasswordChange,
  onCredentialsPasswordReset,
} from '../server/utils/credentials-hooks'
import {
  hashNewPassword,
  passwordUpsert,
  verifySignInProof,
} from '../server/utils/credentials-password'
import {
  changePassword,
  completePasswordReset,
  requestPasswordReset,
} from '../server/utils/credentials-reset'
import {
  addUser,
  db,
  fakeHasher,
  KDF,
  proofOf,
  resetCredentialTables,
  schema,
} from './lib/fixtures'

const NOW = Date.parse('2026-11-15T12:00:00Z')
const seconds = (ms: number) => Math.floor(ms / 1000)
const OLD = proofOf('o')
const NEW = { ...KDF, salt: 'ZZECAwQFBgcICQoLDA0ODw', proof: proofOf('n') }
const hasher = fakeHasher()

beforeEach(async () => {
  await resetCredentialTables()
  clearCredentialsHooksForTest()
  await addUser('u1', 'ada@example.com')
  await passwordUpsert(db, 'u1', await hashNewPassword(hasher, { ...KDF, proof: OLD }))
})

describe('requestPasswordReset', () => {
  it('delivers to an account and not to a stranger, writing a row either way', async () => {
    const known = await requestPasswordReset(db, 'Ada@example.com', NOW)
    const unknown = await requestPasswordReset(db, 'nobody@example.com', NOW)
    expect(known.deliver).toBe(true)
    expect(unknown.deliver).toBe(false)
    expect(await db.query.credentialTokens.findMany()).toHaveLength(2)
  })

  it('cannot be completed for an address with no account', async () => {
    const { token } = await requestPasswordReset(db, 'nobody@example.com', NOW)
    expect(await completePasswordReset(db, hasher, token, NEW, NOW)).toEqual({
      ok: false,
      reason: 'invalid',
    })
  })

  it('does not deliver to a deleted account', async () => {
    await addUser('gone', 'deleted-gone@deleted.invalid')
    expect((await requestPasswordReset(db, 'deleted-gone@deleted.invalid', NOW)).deliver).toBe(
      false,
    )
  })
})

describe('completePasswordReset', () => {
  it('replaces the password: the new proof signs in and the old one does not', async () => {
    const { token } = await requestPasswordReset(db, 'ada@example.com', NOW)
    const result = await completePasswordReset(db, hasher, token, NEW, NOW + 1000)
    expect(result.ok).toBe(true)

    expect((await verifySignInProof(db, hasher, 'ada@example.com', NEW.proof))?.id).toBe('u1')
    expect(await verifySignInProof(db, hasher, 'ada@example.com', OLD)).toBeNull()
    expect(await db.query.credentialPasswords.findFirst()).toMatchObject({ salt: NEW.salt })
  })

  it('ends every session issued before it, and keeps the one issued with it', async () => {
    const at = NOW + 60_000
    const { token } = await requestPasswordReset(db, 'ada@example.com', NOW)
    await completePasswordReset(db, hasher, token, NEW, at)

    expect(await checkSession(db, { userId: 'u1', issuedAt: seconds(NOW) })).toEqual({
      valid: false,
      reason: 'revoked',
    })
    expect(await checkSession(db, { userId: 'u1', issuedAt: seconds(at) - 1 })).toMatchObject({
      valid: false,
    })
    // The session the reset route issues, in the same second as the watermark.
    expect(await checkSession(db, { userId: 'u1', issuedAt: seconds(at) })).toMatchObject({
      valid: true,
    })
  })

  it('works once', async () => {
    const { token } = await requestPasswordReset(db, 'ada@example.com', NOW)
    await completePasswordReset(db, hasher, token, NEW, NOW)
    expect(await completePasswordReset(db, hasher, token, NEW, NOW)).toEqual({
      ok: false,
      reason: 'used',
    })
  })

  it('leaves the password and the sessions alone when the token is bad', async () => {
    expect((await completePasswordReset(db, hasher, 'x'.repeat(43), NEW, NOW)).ok).toBe(false)
    expect((await verifySignInProof(db, hasher, 'ada@example.com', OLD))?.id).toBe('u1')
    expect(await checkSession(db, { userId: 'u1', issuedAt: 1 })).toMatchObject({ valid: true })
  })

  it("runs the app's reset hook in the same batch, then its after step", async () => {
    await addUser('u2', 'grace@example.com')
    const after: string[] = []
    onCredentialsPasswordReset({
      key: 'keys',
      // Stands in for "delete this account's password-wrapped key".
      statements: (database, event) => [
        database
          .update(schema.users)
          .set({ name: `rewrapped at ${event.at.toISOString()}` })
          .where(eq(schema.users.id, event.userId)),
      ],
      after: async (_database, event) => void after.push(event.userId),
    })
    const { token } = await requestPasswordReset(db, 'ada@example.com', NOW)
    await completePasswordReset(db, hasher, token, NEW, NOW)

    const users = await db.query.users.findMany({ orderBy: schema.users.id })
    expect(users.map((user) => user.name)).toEqual([
      `rewrapped at ${new Date(NOW).toISOString()}`,
      'Ada',
    ])
    expect(after).toEqual(['u1'])
  })

  it('rolls the password back when a hook statement fails', async () => {
    onCredentialsPasswordReset({
      key: 'broken',
      // Violates the unique index on users.email.
      statements: (database) => [
        database.insert(schema.users).values({ id: 'dup', email: 'ada@example.com', name: 'x' }),
      ],
    })
    const { token } = await requestPasswordReset(db, 'ada@example.com', NOW)
    await expect(completePasswordReset(db, hasher, token, NEW, NOW)).rejects.toThrow()
    expect((await verifySignInProof(db, hasher, 'ada@example.com', OLD))?.id).toBe('u1')
    expect(await checkSession(db, { userId: 'u1', issuedAt: 1 })).toMatchObject({ valid: true })
  })

  it('does not undo the reset when an after step throws', async () => {
    onCredentialsPasswordReset({
      key: 'flaky',
      after: async () => {
        throw new Error('downstream is down')
      },
    })
    const { token } = await requestPasswordReset(db, 'ada@example.com', NOW)
    expect((await completePasswordReset(db, hasher, token, NEW, NOW)).ok).toBe(true)
  })

  it('does not fire the change hook', async () => {
    let changed = 0
    onCredentialsPasswordChange({ key: 'k', after: async () => void changed++ })
    const { token } = await requestPasswordReset(db, 'ada@example.com', NOW)
    await completePasswordReset(db, hasher, token, NEW, NOW)
    expect(changed).toBe(0)
  })
})

describe('changePassword', () => {
  it('needs the current password', async () => {
    expect(await changePassword(db, hasher, 'u1', proofOf('w'), NEW, NOW)).toEqual({
      ok: false,
      reason: 'wrong_password',
    })
    expect((await verifySignInProof(db, hasher, 'ada@example.com', OLD))?.id).toBe('u1')
  })

  it('refuses an account that has no password to check', async () => {
    await addUser('u2', 'grace@example.com')
    expect(await changePassword(db, hasher, 'u2', OLD, NEW, NOW)).toEqual({
      ok: false,
      reason: 'no_password',
    })
  })

  it('replaces the password, ends older sessions, and fires the change hook only', async () => {
    const fired: string[] = []
    onCredentialsPasswordChange({ key: 'k', after: async () => void fired.push('change') })
    onCredentialsPasswordReset({ key: 'k', after: async () => void fired.push('reset') })

    expect(await changePassword(db, hasher, 'u1', OLD, NEW, NOW)).toEqual({
      ok: true,
      at: new Date(NOW),
    })
    expect((await verifySignInProof(db, hasher, 'ada@example.com', NEW.proof))?.id).toBe('u1')
    expect(await checkSession(db, { userId: 'u1', issuedAt: seconds(NOW) - 1 })).toMatchObject({
      valid: false,
    })
    expect(await checkSession(db, { userId: 'u1', issuedAt: seconds(NOW) })).toMatchObject({
      valid: true,
    })
    expect(fired).toEqual(['change'])
  })

  it('leaves an audit row saying why the sessions ended', async () => {
    await changePassword(db, hasher, 'u1', OLD, NEW, NOW)
    const [row] = await db.query.auditLog.findMany()
    expect(row).toMatchObject({
      action: 'account.sessions_revoked',
      actorUserId: 'u1',
      metadata: { cause: 'password_change' },
    })
  })
})
