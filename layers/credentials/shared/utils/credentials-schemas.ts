// Request shapes, shared by the forms and the routes so the two cannot disagree.

import { z } from 'zod'

import { CREDENTIALS_MAX_ITERATIONS, CREDENTIALS_MIN_ITERATIONS } from './credentials-kdf'

/** The server never sees a password, so its length is enforced in the form only. */
export const CREDENTIALS_MIN_PASSWORD_LENGTH = 10

export const credentialsEmailSchema = z.string().trim().email().max(254)

/** 32 bytes, base64url without padding. */
export const credentialsProofSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)

/** 16 bytes, base64url without padding. */
export const credentialsSaltSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/)

export const credentialsIterationsSchema = z
  .number()
  .int()
  .min(CREDENTIALS_MIN_ITERATIONS)
  .max(CREDENTIALS_MAX_ITERATIONS)

export const credentialsTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/)

/** A new password as the server stores it: the proof and how it was derived. */
export const credentialsNewPasswordSchema = z.object({
  salt: credentialsSaltSchema,
  iterations: credentialsIterationsSchema,
  proof: credentialsProofSchema,
})

export type CredentialsNewPassword = z.infer<typeof credentialsNewPasswordSchema>

export const credentialsPasswordFieldSchema = z
  .string()
  .min(
    CREDENTIALS_MIN_PASSWORD_LENGTH,
    `Use at least ${CREDENTIALS_MIN_PASSWORD_LENGTH} characters`,
  )
  .max(1024)

export const credentialsPasskeyLabelSchema = z.string().trim().min(1).max(60)
