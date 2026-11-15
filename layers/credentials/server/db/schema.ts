import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// The credentials layer's tables. The app's server/db/schema.ts re-exports this
// file so core's typed `db` and drizzle-kit see them; migrations stay app-owned.
// `.references()` takes a lazy callback, so the cycle with that re-export is safe.
import { users } from '../../../../server/db/schema'

const createdAt = integer('created_at', { mode: 'timestamp' })
  .$defaultFn(() => new Date())
  .notNull()

const updatedAt = integer('updated_at', { mode: 'timestamp' })
  .$defaultFn(() => new Date())
  .$onUpdateFn(() => new Date())
  .notNull()

// One row per account that can sign in with a password. A row exists only once
// the address was proven by mail (sign-up verification or a reset link), which
// is what lets the sign-in route assert `emailVerified: true`.
export const credentialPasswords = sqliteTable('credential_passwords', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id),
  // nuxt-auth-utils' scrypt hash of the browser-derived sign-in proof. The
  // password itself never reaches the server.
  proofHash: text('proof_hash').notNull(),
  // What the browser needs to derive the proof again. Not secret: the params
  // endpoint returns them to anyone who asks for this address.
  salt: text('salt').notNull(),
  iterations: integer('iterations').notNull(),
  kdfVersion: integer('kdf_version').notNull().default(1),
  createdAt,
  updatedAt,
})

export const credentialPasskeys = sqliteTable(
  'credential_passkeys',
  {
    // The WebAuthn credential id (base64url), unique across every authenticator.
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    publicKey: text('public_key').notNull(),
    counter: integer('counter').notNull().default(0),
    backedUp: integer('backed_up', { mode: 'boolean' }).notNull().default(false),
    transports: text('transports', { mode: 'json' }).$type<string[]>(),
    aaguid: text('aaguid'),
    name: text('name').notNull(),
    // Whether the authenticator said it can evaluate PRF. Display only: the
    // output itself is never sent here.
    prfCapable: integer('prf_capable', { mode: 'boolean' }).notNull().default(false),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
    createdAt,
  },
  (table) => [index('credential_passkeys_user_id_idx').on(table.userId)],
)

// Mailed, single-use tokens: `verify` finishes a sign-up, `reset` sets a new
// password. A `verify` row carries the pending sign-up in `payload`, because no
// `users` row may exist for an address nobody has proven yet.
export const credentialTokens = sqliteTable(
  'credential_tokens',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    purpose: text('purpose').$type<'verify' | 'reset'>().notNull(),
    email: text('email').notNull(),
    // canonicalizeEmailForLimiting(email): the key of the per-mailbox mail budget.
    mailbox: text('mailbox').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    usedAt: integer('used_at', { mode: 'timestamp' }),
    createdAt,
  },
  (table) => [
    index('credential_tokens_mailbox_created_idx').on(table.mailbox, table.createdAt),
    index('credential_tokens_expires_at_idx').on(table.expiresAt),
    index('credential_tokens_used_at_idx').on(table.usedAt),
  ],
)

// WebAuthn challenges, one per ceremony, deleted by the read that spends them.
export const credentialChallenges = sqliteTable(
  'credential_challenges',
  {
    attemptId: text('attempt_id').primaryKey(),
    challenge: text('challenge').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  },
  (table) => [index('credential_challenges_expires_at_idx').on(table.expiresAt)],
)

export type CredentialPassword = typeof credentialPasswords.$inferSelect
export type CredentialPasskey = typeof credentialPasskeys.$inferSelect
export type CredentialToken = typeof credentialTokens.$inferSelect
