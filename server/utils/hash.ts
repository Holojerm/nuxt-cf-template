// One salted hash, used everywhere a value has to be recognisable later without
// being readable now.
//
// Two places need this and they must agree: `feedback.ip_hash` (rate-limiting a
// public endpoint) and the audit trail (an IP, and the needle of an admin's
// user search). Salted with the deployment's session password, so the digests
// are useless outside this deployment and cannot be rainbow-tabled against a
// list of email addresses — which a bare SHA-256 of an email absolutely can be.
//
// What this buys, and its limit: an investigator who already suspects a value
// can hash it and compare. Nobody can go the other way and read the value out.
// That is exactly the property an append-only, never-pruned table needs, since
// anything stored in plaintext there outlives the account it describes.
//
// A leaf on purpose — no imports — so the money code and the workerd test suite
// can both pull it in without dragging Nitro along.

/** Salted SHA-256, hex. Returns null for an absent value so callers can pass through. */
export async function saltedHash(value: string | undefined | null, salt: string) {
  if (!value) return null
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${value}`))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
