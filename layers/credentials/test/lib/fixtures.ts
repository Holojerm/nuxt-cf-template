// Shared by the layer's D1 tests.

import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'

import * as schema from '~~/server/db/schema'
import type { ProofHasher } from '../../server/utils/credentials-password'

export const db = drizzle(env.DB, { schema })
export { schema }

const TABLES = [
  'credential_challenges',
  'credential_tokens',
  'credential_passkeys',
  'credential_passwords',
  'audit_log',
  'users',
]

export async function resetCredentialTables(): Promise<void> {
  for (const table of TABLES) await env.DB.exec(`DELETE FROM ${table}`)
}

export async function addUser(id: string, email: string, name = 'Ada'): Promise<void> {
  await db.insert(schema.users).values({ id, email, name })
}

/**
 * Stands in for nuxt-auth-utils' scrypt, which reads Nuxt runtime config. What
 * matters in a test is that verify() is the only way a proof is compared, and
 * how often it is called.
 */
export function fakeHasher(): ProofHasher & { verifications: number } {
  const digest = async (value: string) => {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`pepper:${value}`))
    return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  const hasher = {
    verifications: 0,
    hash: async (proof: string) => `fake$${await digest(proof)}`,
    async verify(hash: string, proof: string) {
      hasher.verifications += 1
      return hash === `fake$${await digest(proof)}`
    },
  }
  return hasher
}

/** A well-formed proof (43 base64url characters) that is nobody's. */
export const proofOf = (seed: string): string => seed.repeat(43).slice(0, 43)

export const KDF = { salt: 'AAECAwQFBgcICQoLDA0ODw', iterations: 600_000 }
