// The derivation, against values computed independently with node:crypto
// (pbkdf2Sync then hkdfSync). If one of these moves, every stored password and
// every key wrapped under an unlock key stops opening.
//
// workerd refuses PBKDF2 above 100,000 rounds, so the vectors stop there; the
// 600,000 a browser runs differs only in that number.

import { describe, expect, it } from 'vitest'

import {
  credentialsBase64url,
  credentialsFromBase64url,
  CREDENTIALS_SALT_BYTES,
  deriveCredentials,
  generateKdfSalt,
} from '../shared/utils/credentials-kdf'

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

const VECTORS = [
  {
    password: 'correct horse battery staple',
    salt: 'AAECAwQFBgcICQoLDA0ODw',
    iterations: 1000,
    proof: 'aoG5Q4QzGnJXPHTpom_EWjvcEsKX5s0bgOrFNVTkr_M',
    unlock: 'f8a0abd4c9cf4e8ca52ba5ba5c4d76d54ed3e591639d5d6d80228e1a2560eb8b',
  },
  {
    // Non-ASCII, with a ligature NFKC rewrites ("ﬁ" becomes "fi").
    password: 'pässwörd ﬁ',
    salt: '_-7dzLuqmYh3ZlVEMyIRAA',
    iterations: 100_000,
    proof: 'Y4snE-J7sOxvqXfPCmC49cOirof5gOhtwe3EenblaR4',
    unlock: 'ab7cbc29fdc0c994f31d8ef71c7a3e4954d189200b761b466d2b03967b8b1625',
  },
]

describe('deriveCredentials', () => {
  it.each(VECTORS)('matches the fixed vector at $iterations rounds', async (vector) => {
    const derived = await deriveCredentials(vector.password, vector)
    expect(derived.proof).toBe(vector.proof)
    expect(hex(derived.unlockKey)).toBe(vector.unlock)
  })

  it('derives a 32-byte unlock key that is not the proof', async () => {
    const { proof, unlockKey } = await deriveCredentials('hunter2hunter2', VECTORS[0]!)
    expect(unlockKey).toHaveLength(32)
    expect(credentialsBase64url(unlockKey)).not.toBe(proof)
  })

  it('treats two spellings of the same password as one (NFKC)', async () => {
    const params = VECTORS[0]!
    const composed = await deriveCredentials('caf\u00e9-au-lait', params)
    const decomposed = await deriveCredentials('cafe\u0301-au-lait', params)
    expect(decomposed.proof).toBe(composed.proof)
    expect(hex(decomposed.unlockKey)).toBe(hex(composed.unlockKey))
  })

  it('changes both outputs when the salt or the round count changes', async () => {
    const base = await deriveCredentials('hunter2hunter2', {
      salt: VECTORS[0]!.salt,
      iterations: 1000,
    })
    const salted = await deriveCredentials('hunter2hunter2', {
      salt: VECTORS[1]!.salt,
      iterations: 1000,
    })
    const slower = await deriveCredentials('hunter2hunter2', {
      salt: VECTORS[0]!.salt,
      iterations: 1001,
    })
    for (const other of [salted, slower]) {
      expect(other.proof).not.toBe(base.proof)
      expect(hex(other.unlockKey)).not.toBe(hex(base.unlockKey))
    }
  })
})

describe('salts and encoding', () => {
  it('generates a fresh 16-byte salt each time', () => {
    const a = generateKdfSalt()
    const b = generateKdfSalt()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(credentialsFromBase64url(a)).toHaveLength(CREDENTIALS_SALT_BYTES)
  })

  it('round-trips base64url without padding', () => {
    const bytes = Uint8Array.of(0xfb, 0xff, 0x00, 0x3e, 0x3f)
    const text = credentialsBase64url(bytes)
    expect(text).not.toMatch(/[+/=]/)
    expect([...credentialsFromBase64url(text)]).toEqual([...bytes])
  })
})
