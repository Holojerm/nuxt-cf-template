// Local dev DB seeder — run with `bun seed`.
//
// NuxtHub serves the dev DB from .data/db/sqlite.db (hub.dir defaults to .data).
// Wrangler's own local D1 lives at .wrangler/state/v3/d1/ — DO NOT seed there;
// the dev server will not read it. Reach NuxtHub's file directly via bun:sqlite.
//
// Idempotent: re-running won't duplicate rows.

import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

import * as schema from '../server/db/schema'
import { generateReferralCode } from '../server/utils/users'

const DB_PATH = resolve(import.meta.dir, '../.data/db/sqlite.db')

if (!existsSync(DB_PATH)) {
  console.error(`No local DB at ${DB_PATH}.`)
  console.error('Start the dev server once (bun dev) so NuxtHub creates the file, then re-run.')
  process.exit(1)
}

const sqlite = new Database(DB_PATH)
const db = drizzle(sqlite, { schema })

const seedUsers = [
  { email: 'demo@example.com', name: 'Demo User', role: 'user' },
  { email: 'admin@example.com', name: 'Admin User', role: 'admin' },
]

for (const user of seedUsers) {
  const existing = await db.query.users.findFirst({ where: eq(schema.users.email, user.email) })
  if (existing) {
    console.info(`= ${user.email} already exists, skipping`)
    continue
  }
  // Minted with the real generator, not left null. Seeded accounts otherwise
  // skip the one code path that gives every user a referral code, so anything
  // built on `referral_code` looks broken in dev for exactly the two accounts a
  // developer actually signs in as.
  await db.insert(schema.users).values({ ...user, referralCode: generateReferralCode() })
  console.info(`+ ${user.email}`)
}

console.info('Done.')
