// Local dev DB seeder — run with `bun seed`.
//
// NuxtHub serves the dev DB from .data/db/sqlite.db (hub.dir defaults to .data).
// Wrangler's own local D1 lives at .wrangler/state/v3/d1/ — DO NOT seed there;
// the dev server will not read it. Reach NuxtHub's file directly via bun:sqlite.
//
// Idempotent: re-running won't duplicate rows, on users (by email) and on
// entitlements (by the unique Paddle ref).
//
// ── One user per entitlement status (Findings 18 + 20) ───────────────────────
// The first version of this script seeded two users, neither entitled — every
// billing-state UI (the past_due alert, the "ended" plan card on /account, the
// comp/referral badges in billing history) could only ever be reached by
// hand-editing the local DB. Sign in as any of the emails below via the dev
// endpoint (POST /api/auth/dev — no password, dev-only, see
// server/api/auth/dev.post.ts) and you land directly on that state:
//
//   seed-active-sub@example.com     active subscription
//   seed-trialing@example.com       subscription mid-trial
//   seed-past-due@example.com       failed payment, dunning (see /account)
//   seed-paused@example.com         subscription paused (no access)
//   seed-canceled@example.com       subscription ended (no access)
//   seed-pass-active@example.com    one-time pass, still running
//   seed-pass-expired@example.com   one-time pass, ran out (no access)
//   seed-comp@example.com           admin-comped pass, still running
//
// These rows are for eyeballing the UI by hand. test/e2e/**'s specs
// deliberately do NOT sign in as any of them — each of those mints its own
// fresh user and drives it through a real Paddle webhook, because the whole
// point there is proving the purchase/cancellation path works starting from
// nothing, not asserting on state this script happened to insert.

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

const DAY_MS = 24 * 60 * 60 * 1000
const now = new Date()

interface SeedEntitlement {
  /** The Paddle ref — `sub_…`, `txn_…`, or `comp_…`. Unique, so re-runs skip it. */
  ref: string
  status: string
  currentPeriodEnd: Date | null
}

interface SeedUser {
  email: string
  name: string
  role: string
  entitlement?: SeedEntitlement
}

const seedUsers: SeedUser[] = [
  { email: 'demo@example.com', name: 'Demo User', role: 'user' },
  { email: 'admin@example.com', name: 'Admin User', role: 'admin' },
  {
    email: 'seed-active-sub@example.com',
    name: 'Active Subscriber',
    role: 'user',
    entitlement: {
      ref: 'sub_seed_active',
      status: 'active',
      currentPeriodEnd: new Date(now.getTime() + 30 * DAY_MS),
    },
  },
  {
    email: 'seed-trialing@example.com',
    name: 'Trialing Subscriber',
    role: 'user',
    entitlement: {
      ref: 'sub_seed_trialing',
      status: 'trialing',
      currentPeriodEnd: new Date(now.getTime() + 14 * DAY_MS),
    },
  },
  {
    email: 'seed-past-due@example.com',
    name: 'Past-Due Subscriber',
    role: 'user',
    // Recent, so server/utils/billing-state.ts's PAST_DUE_STALE_AFTER_DAYS
    // window reads this as live dunning rather than a subscription Paddle
    // already gave up on and no webhook ever closed out.
    entitlement: { ref: 'sub_seed_past_due', status: 'past_due', currentPeriodEnd: now },
  },
  {
    email: 'seed-paused@example.com',
    name: 'Paused Subscriber',
    role: 'user',
    entitlement: {
      ref: 'sub_seed_paused',
      status: 'paused',
      currentPeriodEnd: new Date(now.getTime() + 30 * DAY_MS),
    },
  },
  {
    email: 'seed-canceled@example.com',
    name: 'Canceled Subscriber',
    role: 'user',
    entitlement: { ref: 'sub_seed_canceled', status: 'canceled', currentPeriodEnd: now },
  },
  {
    email: 'seed-pass-active@example.com',
    name: 'Pass Holder',
    role: 'user',
    entitlement: {
      ref: 'txn_seed_pass_active',
      status: 'active',
      currentPeriodEnd: new Date(now.getTime() + 20 * DAY_MS),
    },
  },
  {
    email: 'seed-pass-expired@example.com',
    name: 'Lapsed Pass Holder',
    role: 'user',
    // Status stays 'active' — a txn_ row has no lifecycle event that ever
    // flips it (see server/utils/paddle-refs.ts). It grants nothing once
    // current_period_end is in the past; that date, not the status, is what
    // makes this one expired.
    entitlement: {
      ref: 'txn_seed_pass_expired',
      status: 'active',
      currentPeriodEnd: new Date(now.getTime() - 5 * DAY_MS),
    },
  },
  {
    email: 'seed-comp@example.com',
    name: 'Comped User',
    role: 'user',
    entitlement: {
      // A fixed ref, not compRef()'s random UUID — that generator is for a
      // real admin grant, where a fresh unique ref every call is the whole
      // point. Here it would mint a NEW ref on every re-run, defeating the
      // "already exists, skip" check below and leaving a pile of comp rows
      // behind. COMP_REF_PREFIX, spelled out, is what isCompRef() actually
      // checks — this just has to start with it.
      ref: 'comp_seed',
      status: 'active',
      currentPeriodEnd: new Date(now.getTime() + 30 * DAY_MS),
    },
  },
]

for (const seedUser of seedUsers) {
  const existing = await db.query.users.findFirst({ where: eq(schema.users.email, seedUser.email) })

  let userId: string
  if (existing) {
    console.info(`= ${seedUser.email} already exists, skipping`)
    userId = existing.id
  } else {
    // Minted with the real generator, not left null — see the original note
    // this replaced: a seeded account otherwise skips the one code path that
    // gives every user a referral code, so anything built on `referral_code`
    // looks broken in dev for exactly the accounts a developer signs in as.
    const [inserted] = await db
      .insert(schema.users)
      .values({
        email: seedUser.email,
        name: seedUser.name,
        role: seedUser.role,
        referralCode: generateReferralCode(),
      })
      .returning({ id: schema.users.id })
    userId = inserted!.id
    console.info(`+ ${seedUser.email}`)
  }

  if (!seedUser.entitlement) continue

  const existingEntitlement = await db.query.entitlements.findFirst({
    where: eq(schema.entitlements.paddleSubscriptionId, seedUser.entitlement.ref),
  })
  if (existingEntitlement) {
    console.info(`  = entitlement ${seedUser.entitlement.ref} already exists, skipping`)
    continue
  }

  await db.insert(schema.entitlements).values({
    userId,
    paddleSubscriptionId: seedUser.entitlement.ref,
    productKey: 'default',
    status: seedUser.entitlement.status,
    currentPeriodEnd: seedUser.entitlement.currentPeriodEnd,
  })
  console.info(`  + entitlement ${seedUser.entitlement.ref} (${seedUser.entitlement.status})`)
}

console.info('Done.')
