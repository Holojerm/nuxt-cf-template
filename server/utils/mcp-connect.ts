// The app's half of the MCP worker's sign-in (mcp/src/authorize.ts): mint a
// single-use code for the signed-in user, bound to the sign-in the worker
// started, and say where to send the browser back to.
//
// The code crosses to the worker through the shared D1 database. Only its
// SHA-256 hash is stored, so a database leak does not leak live codes.

import type { drizzle } from 'drizzle-orm/d1'
import { z } from 'zod'
import * as schema from '../db/schema'
import { mcpOrigin } from '#shared/utils/site'
import { sha256Hex } from './hash'

type Db = ReturnType<typeof drizzle<typeof schema>>

const CODE_TTL_SECONDS = 600
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789' // no 0/O/1/I/L lookalikes

/** The worker's id for a pending sign-in: the SHA-256 of a secret in its cookie. */
export const ConnectRequestSchema = z.object({ request: z.string().regex(/^[a-f0-9]{64}$/) })

function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
}

/**
 * The stored form of a code. Bound to the request id, so a code minted for one
 * sign-in cannot finish another. Mirrors hashConnectCode() in
 * mcp/src/signin.ts; test/mcp-signin.test.ts holds the two together.
 */
export function hashConnectCode(code: string, requestId: string): Promise<string> {
  return sha256Hex(`${code.toUpperCase().replace(/[^A-Z0-9]/g, '')}:${requestId}`)
}

/** Mint a code for `userId`. The plaintext exists only in the return value. */
export async function mintConnectCode(
  db: Db,
  input: { userId: string; requestId: string },
): Promise<string> {
  const code = generateCode()
  await db.insert(schema.mcpConnectCodes).values({
    userId: input.userId,
    codeHash: await hashConnectCode(code, input.requestId),
    expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000),
  })
  return code
}

/**
 * The worker URL that finishes the sign-in, or null when no worker is
 * configured. Built from NUXT_PUBLIC_MCP_URL only, never from the request, so
 * a code can be sent nowhere but this app's own worker.
 */
export function connectCallbackUrl(
  mcpUrl: string | undefined,
  input: { requestId: string; code: string },
): string | null {
  const origin = mcpOrigin(mcpUrl)
  if (!origin) return null
  const url = new URL('/authorize/callback', origin)
  url.searchParams.set('request', input.requestId)
  url.searchParams.set('code', input.code)
  return url.toString()
}
