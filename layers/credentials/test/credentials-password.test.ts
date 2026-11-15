// Proof verification and the enumeration-safe params lookup, against real D1.

import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { resetIdentitySaltCache } from '~~/server/utils/identity'
import { deriveCredentials } from '../shared/utils/credentials-kdf'
import { decoySalt, lookupKdfParams } from '../server/utils/credentials-params'
import {
  hashNewPassword,
  passwordUpsert,
  resetDecoyHashForTest,
  verifyProofForUser,
  verifySignInProof,
} from '../server/utils/credentials-password'
import { addUser, db, fakeHasher, proofOf, resetCredentialTables, schema } from './lib/fixtures'

const PARAMS = { salt: 'AAECAwQFBgcICQoLDA0ODw', iterations: 1000 }

async function register(userId: string, email: string, password: string) {
  const hasher = fakeHasher()
  const { proof } = await deriveCredentials(password, PARAMS)
  await addUser(userId, email)
  await passwordUpsert(db, userId, await hashNewPassword(hasher, { ...PARAMS, proof }))
  return proof
}

beforeEach(async () => {
  await resetCredentialTables()
  await db.delete(schema.instanceSecrets)
  resetIdentitySaltCache()
  resetDecoyHashForTest()
})

describe('verifySignInProof', () => {
  it('accepts the proof the right password derives, and only that one', async () => {
    await register('u1', 'ada@example.com', 'correct horse battery')
    const hasher = fakeHasher()
    const right = await deriveCredentials('correct horse battery', PARAMS)
    const wrong = await deriveCredentials('correct horse batterx', PARAMS)

    expect((await verifySignInProof(db, hasher, 'Ada@Example.com ', right.proof))?.id).toBe('u1')
    expect(await verifySignInProof(db, hasher, 'ada@example.com', wrong.proof)).toBeNull()
  })

  it('stores a hash, never the proof', async () => {
    const proof = await register('u1', 'ada@example.com', 'correct horse battery')
    const row = await db.query.credentialPasswords.findFirst()
    expect(row?.proofHash).not.toContain(proof)
    expect(row).toMatchObject({ salt: PARAMS.salt, iterations: 1000, kdfVersion: 1 })
  })

  it('does one verification for an unknown address, the same as for a known one', async () => {
    await register('u1', 'ada@example.com', 'correct horse battery')
    const known = fakeHasher()
    const unknown = fakeHasher()
    expect(await verifySignInProof(db, known, 'ada@example.com', proofOf('a'))).toBeNull()
    expect(await verifySignInProof(db, unknown, 'nobody@example.com', proofOf('a'))).toBeNull()
    expect(unknown.verifications).toBe(known.verifications)
    expect(unknown.verifications).toBe(1)
  })

  it('refuses an account with no password, and a deleted one', async () => {
    await addUser('u2', 'grace@example.com')
    const proof = await register('u1', 'ada@example.com', 'correct horse battery')
    const hasher = fakeHasher()
    expect(await verifySignInProof(db, hasher, 'grace@example.com', proof)).toBeNull()

    await db
      .update(schema.users)
      .set({ email: 'deleted-u1@deleted.invalid' })
      .where(eq(schema.users.id, 'u1'))
    expect(await verifySignInProof(db, hasher, 'deleted-u1@deleted.invalid', proof)).toBeNull()
  })
})

describe('verifyProofForUser', () => {
  it('tells a wrong password from an account that has none', async () => {
    const proof = await register('u1', 'ada@example.com', 'correct horse battery')
    await addUser('u2', 'grace@example.com')
    const hasher = fakeHasher()
    expect(await verifyProofForUser(db, hasher, 'u1', proof)).toBe('ok')
    expect(await verifyProofForUser(db, hasher, 'u1', proofOf('z'))).toBe('wrong')
    expect(await verifyProofForUser(db, hasher, 'u2', proof)).toBe('no_password')
  })
})

describe('lookupKdfParams', () => {
  it('returns the stored parameters for an account', async () => {
    await register('u1', 'ada@example.com', 'correct horse battery')
    expect(await lookupKdfParams(db, 'ADA@example.com', 600_000)).toEqual(PARAMS)
  })

  it('answers an unknown address with a salt of the same shape, stable across calls', async () => {
    await register('u1', 'ada@example.com', 'correct horse battery')
    const first = await lookupKdfParams(db, 'nobody@example.com', 600_000)
    const second = await lookupKdfParams(db, 'Nobody@Example.com', 600_000)
    expect(second).toEqual(first)
    expect(first.salt).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(first.iterations).toBe(600_000)
    expect(Object.keys(first).sort()).toEqual(Object.keys(PARAMS).sort())
  })

  it('gives each unknown address its own salt', async () => {
    const a = await lookupKdfParams(db, 'a@example.com', 600_000)
    const b = await lookupKdfParams(db, 'b@example.com', 600_000)
    expect(a.salt).not.toBe(b.salt)
  })

  it('derives the decoy from the instance secret, so it cannot be computed from outside', async () => {
    const seen = await lookupKdfParams(db, 'nobody@example.com', 600_000)
    const secret = (await db.query.instanceSecrets.findFirst())!.value
    expect(seen.salt).toBe(await decoySalt(secret, 'nobody@example.com'))
    expect(seen.salt).not.toBe(await decoySalt('another-instance', 'nobody@example.com'))
  })

  it('keeps answering the same for an address after its account appears elsewhere', async () => {
    const before = await lookupKdfParams(db, 'nobody@example.com', 600_000)
    await register('u1', 'ada@example.com', 'correct horse battery')
    expect(await lookupKdfParams(db, 'nobody@example.com', 600_000)).toEqual(before)
  })
})
