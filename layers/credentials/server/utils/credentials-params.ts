// "What salt and iteration count does this address derive with?"
//
// The browser needs the answer before it can compute a sign-in proof, so the
// question is asked by someone who has not authenticated. Answering "no such
// account" would make this the enumeration oracle the rest of the sign-in
// surface avoids, so an unknown address gets an answer too: a salt computed
// from the address and the instance secret. It is stable (asking twice returns
// the same bytes, as it does for a real account) and unpredictable without the
// secret (an outsider cannot compute it to tell the two apart).
//
// One residual, stated rather than hidden: the decoy carries the CURRENT default
// iteration count. After the default is raised, an account still on the old
// count is distinguishable until its password is next changed or reset.

import { eq } from 'drizzle-orm'

import * as tables from '../db/schema'
import { users } from '#server/db/schema'
import type { ExtensionDb } from '#server/utils/extensions'
import { getIdentitySalt } from '#server/utils/identity'
import { normalizeEmail } from '#server/utils/users'
import type { KdfParams } from '../../shared/utils/credentials-kdf'
import { CREDENTIALS_SALT_BYTES, credentialsBase64url } from '../../shared/utils/credentials-kdf'

const encoder = new TextEncoder()

/** HMAC-SHA256(instance secret, address), cut to a salt's length. */
export async function decoySalt(instanceSecret: string, email: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(instanceSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`credentials-kdf-salt:${normalizeEmail(email)}`),
  )
  return credentialsBase64url(new Uint8Array(mac).slice(0, CREDENTIALS_SALT_BYTES))
}

/**
 * Both branches run for every address (the account read and the decoy), so the
 * work done does not depend on whether the account exists.
 */
export async function lookupKdfParams(
  db: ExtensionDb,
  email: string,
  defaultIterations: number,
): Promise<KdfParams> {
  const normalized = normalizeEmail(email)
  const [rows, secret] = await Promise.all([
    db
      .select({
        salt: tables.credentialPasswords.salt,
        iterations: tables.credentialPasswords.iterations,
      })
      .from(tables.credentialPasswords)
      .innerJoin(users, eq(users.id, tables.credentialPasswords.userId))
      .where(eq(users.email, normalized))
      .limit(1),
    getIdentitySalt(db),
  ])
  const decoy = { salt: await decoySalt(secret, normalized), iterations: defaultIterations }
  const real = rows[0]
  return real ? { salt: real.salt, iterations: real.iterations } : decoy
}
