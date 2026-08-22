// Mint a short-lived, single-use connect code for the signed-in user. The MCP
// worker's /authorize page exchanges it for an OAuth grant (see mcp/README.md).
// Auth comes from the global /api/* middleware; only the code's SHA-256 hash
// is stored, so a DB leak doesn't leak live codes.

import { sha256Hex } from '../../utils/hash'

const CODE_TTL_SECONDS = 600 // 10 minutes
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789' // no 0/O/1/I/L lookalikes

function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('')
  return `${chars.slice(0, 4)}-${chars.slice(4)}`
}

export async function hashConnectCode(code: string): Promise<string> {
  // Normalised before hashing so the dash and the casing a user types back are
  // irrelevant. The digest itself is the shared one — see server/utils/hash.ts.
  return sha256Hex(code.toUpperCase().replace(/[^A-Z0-9]/g, ''))
}

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)

  // Keyed by user, not IP: a signed-in account minting codes in a loop is the
  // realistic abuse here (each one is a row and a live credential), and users
  // behind one corporate NAT shouldn't rate-limit each other.
  await rateLimit(event, {
    name: 'mcp-connect-code',
    identifier: user.id,
    limit: 10,
    windowSeconds: 300,
  })

  const code = generateCode()
  const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000)
  await db.insert(schema.mcpConnectCodes).values({
    userId: user.id,
    codeHash: await hashConnectCode(code),
    expiresAt,
  })

  // The plaintext code exists only in this response — show it to the user once.
  return { code, expiresAt: expiresAt.toISOString() }
})
