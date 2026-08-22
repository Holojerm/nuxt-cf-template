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
// can both pull it in without dragging Nitro along. That is also why the small
// primitives below live here rather than being re-typed in each module that
// needs one: there were four copies of the hex-digest loop and two of
// timingSafeEqual, all correct, and all of them a place where the next one
// could quietly not be.

const encoder = new TextEncoder()

/** Bytes → lowercase hex. The tail of every digest in this codebase. */
export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

/** Bytes → base64url, unpadded. URL-safe with no percent-encoding. */
export function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** SHA-256 of a string, hex. */
export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
}

/**
 * Constant-time string comparison.
 *
 * `===` short-circuits on the first differing byte, which leaks how much of a
 * guessed token was correct through response timing. Fixed-cost XOR
 * accumulation over equal-length inputs does not. Length is compared first and
 * non-constant-time on purpose — the length of a signature is not a secret, and
 * comparing unequal-length buffers byte-wise is meaningless anyway.
 *
 * One copy, shared by the Paddle webhook signature check and the unsubscribe
 * token check. Two copies of a timing-safe compare is one copy too many: the
 * second is where somebody "simplifies" the loop.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a)
  const bb = encoder.encode(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!
  return diff === 0
}

/** Salted SHA-256, hex. Returns null for an absent value so callers can pass through. */
export async function saltedHash(value: string | undefined | null, salt: string) {
  if (!value) return null
  return sha256Hex(`${salt}:${value}`)
}
