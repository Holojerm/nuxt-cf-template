// A durable record that a mailbox has spent its welcome trial, for an app that
// cannot rely on the entitlement row to remember.
//
// The template's welcome grant is once per MAILBOX because its ref (`welcome_<salted
// mailbox hash>`) meets a unique index on `entitlements`, and an account deletion
// keeps entitlements (the `users` row survives as a tombstone), so the row outlives
// the account and the trial cannot be re-armed by deleting and re-registering. An
// app whose account deletion removes the entitlement rows (a hard delete) loses
// that row with the account, and the same address would be handed seven days again,
// forever. Such an app registers a ledger that lives somewhere deletion does not
// reach (its own table, never touched by the deletion batch).
//
//   registerWelcomeLedger({
//     spent: async (db, ref) => Boolean(await db.query.myWelcomeGrants.findFirst({ where: … })),
//     markSpent: async (db, ref) => { await db.insert(…).onConflictDoNothing() },
//   })
//
// ── Contract ─────────────────────────────────────────────────────────────────
// - `spent` is asked BEFORE anything is recorded or written, in front of the
//   entitlement check, so the audit row never claims a grant the ledger refuses.
//   A throw there fails the grant (logged, `error`): refusing is the safe side.
// - `markSpent` runs AFTER the days are written and only when they were. Writing it
//   in front of a grant that then failed would burn somebody's trial for nothing.
//   It must be idempotent, and a throw is logged (`referral_welcome_mark_failed`) and
//   swallowed: the days are already granted and the entitlement row still remembers
//   until the account is deleted.
// - The `ref` is the same salted-hash string the entitlement carries; it holds no
//   address. The ledger must never be pruned: a deleted row is a re-armed trial.
//
// Nothing registered: the entitlement row is the only record, exactly as before.

import type { ExtensionDb } from '#server/utils/extensions'

export interface WelcomeLedger {
  spent: (db: ExtensionDb, ref: string) => Promise<boolean>
  markSpent: (db: ExtensionDb, ref: string) => Promise<void>
}

let ledger: WelcomeLedger | null = null

export function registerWelcomeLedger(next: WelcomeLedger): void {
  ledger = next
}

export function getWelcomeLedger(): WelcomeLedger | null {
  return ledger
}

/** Test-only: forget the ledger. */
export function clearWelcomeLedgerForTest(): void {
  ledger = null
}
