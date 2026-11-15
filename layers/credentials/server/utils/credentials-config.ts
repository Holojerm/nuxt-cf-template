// The layer's options, and the switch every route checks first.

import type { H3Event } from 'h3'

export interface CredentialsOptions {
  enabled: boolean
  primary: boolean
  prf: boolean
  /** PBKDF2 rounds a new password must be derived with. */
  iterations: number
}

export function credentialsOptions(event?: H3Event): CredentialsOptions {
  return useRuntimeConfig(event).public.credentials
}

/** 404, not 403: a fork that has not turned the layer on has no such routes. */
export function requireCredentialsEnabled(event: H3Event): CredentialsOptions {
  const options = credentialsOptions(event)
  if (!options.enabled) throw createError({ statusCode: 404, message: 'Not found' })
  return options
}

/**
 * Refuse a new password derived with fewer rounds than this deployment asks
 * for. The count is the client's to choose, so without this a modified client
 * could store an account at the schema's floor.
 */
export function requireKdfStrength(options: CredentialsOptions, iterations: number): void {
  if (iterations < options.iterations) {
    throw createError({
      statusCode: 400,
      message: 'Key derivation is weaker than this app accepts',
      data: { code: 'weak_kdf' },
    })
  }
}

/** nuxt-auth-utils' scrypt, in the shape credentials-password.ts takes. */
export const scryptProofHasher = {
  hash: (proof: string) => hashPassword(proof),
  verify: (hash: string, proof: string) => verifyPassword(hash, proof),
}
