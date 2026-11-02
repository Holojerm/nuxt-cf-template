// Self-serve account deletion and data export — exactly what /privacy
// promises, no more: "deletion of your account and its contents", "a copy of
// your data", billing records kept as tax law requires.
//
// Like layers/billing/server/utils/entitlements.ts and server/utils/audit.ts, every function
// here takes the Drizzle client as its first argument rather than reaching for
// the auto-imported `db`, so test/account.test.ts can drive it against a real
// D1 binding without booting Nitro. Uploaded files (R2) are swept by the files
// layer's contributor, which imports `blob` explicitly for the same reason.
//
// ── Anonymize the row, don't erase it ────────────────────────────────────────
// `users.id` has to survive: `entitlements.user_id` is a real foreign key, and
// entitlement rows are the billing history /privacy says is kept for tax law.
// Erasing the row would either violate that constraint or orphan the
// entitlements it's attached to. So "delete the account" means: scrub every
// personally-identifying column on the `users` row in place, and hard-delete
// everything that exists only to serve this person directly.
//
// ── Optional features ────────────────────────────────────────────────────────
// Tables owned by an optional feature (feedback today) are not read here. The
// feature registers an AccountContributor (server/utils/extensions.ts) that
// counts, scrubs and exports its own rows, so deletion and export stay complete
// when the feature is there and correct when it is not.

import { and, count, desc, eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'
import * as tables from '../db/schema'
import type { AuditMetadata } from '../db/schema'
import { withAudit, writeAudit } from './audit'
import { collectSections, getAccountContributors, getDeletionGuards } from './extensions'
import type { AccountExportSections } from './extensions'
import { OPTIONAL_NOTIFICATION_EVENT_TYPES } from '#shared/utils/notifications'

/** The Drizzle client shape — matches the `db` NuxtHub auto-imports. */
export type AccountDb = ReturnType<typeof drizzle<typeof tables>>

/**
 * The tombstone address a deleted account's row is rewritten to. Unique
 * (keyed on the id, which survives deletion) and obviously synthetic —
 * `.invalid` is the TLD RFC 2606 reserves for addresses that must never
 * resolve, so nothing downstream mistakes it for a real one.
 */
function tombstoneEmail(userId: string): string {
  return `deleted-${userId}@deleted.invalid`
}

export type DeleteAccountOutcome =
  | { outcome: 'not_found' }
  /**
   * Refused by a registered DeletionGuard (server/utils/extensions.ts); see the
   * policy note on deleteAccount(). `code`, `message` and `data` are the
   * guard's, passed through to the 409 unchanged (billing: `live_subscription`).
   */
  | { outcome: 'blocked'; code: string; message: string; data: Record<string, unknown> }
  /**
   * Done. Deliberately carries no tally: what was deleted is recorded on the
   * audit row, which is the copy that outlives the request and the one an
   * investigation actually reads. A second count in the return value was read
   * by nothing but the tests that asserted it, and two tallies of the same
   * event are two things that can disagree.
   */
  | { outcome: 'deleted' }

/**
 * Delete a self-serve account.
 *
 * ── Refusing a live subscription is the one justified guard ─────────────────
 * It lives with billing, which registers it as a DeletionGuard
 * (layers/billing/server/utils/billing-extensions.ts); the reasoning stays here because it is
 * the case for having a guard seam at all. Every other exit from this app is deliberately frictionless (see
 * layers/billing/app/utils/churn.ts) — but deleting the `users` row does not touch Paddle,
 * which owns the subscription's billing lifecycle independently of whether
 * that row still exists. Anonymizing it out from under a live subscription
 * would not stop the next renewal; Paddle would keep charging a card attached
 * to an account nobody can look up anymore. Refusing up front, and pointing at
 * the portal cancellation path this app already has, is one extra step
 * against a customer getting billed after they believed they'd left — the one
 * case where adding friction protects the customer rather than the business.
 * Passes and comps (`txn_…`, `comp_…`) don't block: nothing renews them, so
 * deleting the account simply forfeits whatever time was left.
 *
 * ── Audit before act ─────────────────────────────────────────────────────────
 * Row counts are read FIRST — server/utils/audit.ts's policy is that an audit
 * row describes intent, not outcome, and "how many rows this is about to
 * touch" is knowable before touching them. Those counts become the audit
 * metadata, and the actual deletes run inside withAudit()'s callback, so a
 * failed audit write blocks the destruction entirely rather than following it.
 */
export async function deleteAccount(db: AccountDb, userId: string): Promise<DeleteAccountOutcome> {
  const user = await db.query.users.findFirst({ where: eq(tables.users.id, userId) })
  if (!user) return { outcome: 'not_found' }

  for (const guard of getDeletionGuards()) {
    const block = await guard.check(db, userId)
    if (block) return { outcome: 'blocked', ...block, data: block.data ?? {} }
  }

  const contributors = getAccountContributors()
  const [[connectCodeTotal], [magicLinkTotal], [notificationTotal], contributorCounts] =
    await Promise.all([
      db
        .select({ total: count() })
        .from(tables.mcpConnectCodes)
        .where(eq(tables.mcpConnectCodes.userId, userId)),
      // Keyed by address, not user id — a magic link is minted for an address
      // before we know whether it has an account (server/db/schema.ts).
      db
        .select({ total: count() })
        .from(tables.magicLinkTokens)
        .where(eq(tables.magicLinkTokens.email, user.email)),
      db
        .select({ total: count() })
        .from(tables.notificationPreferences)
        .where(eq(tables.notificationPreferences.userId, userId)),
      Promise.all(contributors.map((c) => c.countForDeletion?.(db, userId))),
    ])

  const metadata: AuditMetadata = {
    connectCodesCount: connectCodeTotal?.total ?? 0,
    magicLinkTokensCount: magicLinkTotal?.total ?? 0,
    notificationPreferencesCount: notificationTotal?.total ?? 0,
  }
  contributors.forEach((c, i) => {
    if (c.countForDeletion) metadata[c.countKey ?? `${c.key}Count`] = contributorCounts[i] ?? 0
  })

  return withAudit(
    db,
    {
      actorUserId: userId,
      actorType: 'user',
      action: 'account.deleted',
      targetType: 'user',
      targetId: userId,
      metadata,
    },
    async (): Promise<DeleteAccountOutcome> => {
      // Contributors' out-of-batch work first (the files layer sweeps R2 here,
      // while its rows still name the objects). See AccountContributor.
      for (const c of contributors) await c.beforeDeletion?.(db, userId)

      // One batch, not a run of awaited statements. D1 runs a batch as a single
      // transaction and a single round trip, which matters twice here: the
      // latency of five sequential trips is paid by a person watching a spinner
      // on the most anxious button in the app, and — more importantly — a
      // failure partway through the sequential version left an account half
      // deleted, with its files gone and its identity intact. Atomic is the
      // property this operation should have had from the start.
      //
      // The order inside the batch is still meaningful for reading: credentials
      // first, then owned rows, then the identity itself.
      await db.batch([
        db.delete(tables.mcpConnectCodes).where(eq(tables.mcpConnectCodes.userId, userId)),

        // Outstanding sign-in links are live credentials for this address, the
        // same class of thing as the connect codes above, and deleting an
        // account has to revoke the credentials that reach it. Without this a
        // link minted minutes earlier stays redeemable — it would create a
        // fresh empty account rather than resurrect this one (the tombstone
        // address no longer matches), but "I deleted my account and a stale
        // email signed me into a new one" is not a sentence a deletion flow
        // should make possible.
        db.delete(tables.magicLinkTokens).where(eq(tables.magicLinkTokens.email, user.email)),

        db
          .delete(tables.notificationPreferences)
          .where(eq(tables.notificationPreferences.userId, userId)),

        ...contributors.flatMap((c) => c.deletionStatements?.(db, userId) ?? []),

        db
          .update(tables.users)
          .set({
            email: tombstoneEmail(userId),
            name: 'Deleted user',
            avatarUrl: null,
            provider: null,
            signupSource: null,
            signupMedium: null,
            signupCampaign: null,
            signupReferrer: null,
            referralCode: null,
            // referredBy is left alone on purpose — it names the OTHER
            // account's referral code, not this one's, and this account leaving
            // doesn't get to erase where somebody else's customer came from.
            //
            // The one line that makes deletion mean anything on a device other
            // than this one. Sessions are sealed cookies with no server-side
            // record, so without this watermark the phone in the other room
            // keeps full access to the entitlements this row still carries
            // until its cookie expires. See server/utils/session-guard.ts.
            sessionsInvalidBefore: new Date(),
          })
          .where(eq(tables.users.id, userId)),
      ])

      return { outcome: 'deleted' }
    },
  )
}

// ─── Sign out everywhere ─────────────────────────────────────────────────────

export interface RevokeSessionsOutcome {
  outcome: 'revoked' | 'not_found'
  /** The watermark written. Sessions dated before it (in seconds) are dead. */
  at: Date
}

/**
 * Invalidate every session this account holds by moving the watermark
 * `server/utils/session-guard.ts` checks on each request. The caller re-issues
 * its own cookie at the same instant, so "everywhere" means "everywhere else".
 * Same lever as deletion — there is deliberately no second mechanism.
 */
export async function revokeSessions(
  db: AccountDb,
  userId: string,
  now: Date = new Date(),
): Promise<RevokeSessionsOutcome> {
  const [updated] = await db
    .update(tables.users)
    .set({ sessionsInvalidBefore: now })
    .where(eq(tables.users.id, userId))
    .returning({ id: tables.users.id })
  if (!updated) return { outcome: 'not_found', at: now }

  await writeAudit(db, {
    actorUserId: userId,
    actorType: 'user',
    action: 'account.sessions_revoked',
    targetType: 'user',
    targetId: userId,
    metadata: { sessionsInvalidBefore: now.toISOString() },
  })
  return { outcome: 'revoked', at: now }
}

// ─── Data export ─────────────────────────────────────────────────────────────

export interface AccountExportUser {
  id: string
  email: string
  name: string
  avatarUrl: string | null
  role: string
  provider: string | null
  signupSource: string | null
  signupMedium: string | null
  signupCampaign: string | null
  signupReferrer: string | null
  referralCode: string | null
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

/**
 * The EFFECTIVE state of one optional email type — not a raw row. Absence of
 * a `notification_preferences` row means default-on (see schema.ts), so a
 * person who never touched their settings would export an empty array if this
 * read the table directly; that's a correct query and a misleading "copy of
 * your data" all the same. Computed the same way the /account preferences UI
 * itself does (server/api/account/notifications.get.ts), so the export can
 * never disagree with what the toggle already shows.
 */
export interface AccountExportNotificationPreference {
  eventType: string
  enabled: boolean
}

/** Action, timestamp, and who-kind-of-actor only — never the admin's identity. */
export interface AccountExportAuditEntry {
  action: string
  actorType: string
  createdAt: string
}

/** A lifecycle email this account was sent (server/utils/lifecycle.ts). */
export interface AccountExportLifecycleEmail {
  step: string
  sentAt: string
}

export interface AccountExportCore {
  exportedAt: string
  user: AccountExportUser
  notificationPreferences: AccountExportNotificationPreference[]
  lifecycleEmails: AccountExportLifecycleEmail[]
  auditEntries: AccountExportAuditEntry[]
}

/** Core fields plus one key per registered feature (e.g. `feedback`). */
export type AccountExport = AccountExportCore & Partial<AccountExportSections>

/**
 * Everything /privacy promises a "copy of your data" means, as one document.
 *
 * `user` omits `referred_by` on purpose — it's the OTHER account's referral
 * code, not data about this person, the same reasoning deleteAccount() uses to
 * leave it untouched. `auditEntries` omits `actor_user_id` on purpose too:
 * these are the privileged actions taken ON this account (an admin viewing it,
 * this deletion itself), and naming which admin looked is a fact about that
 * admin, not about the export's owner — the console has its own view for that.
 */
export async function exportAccount(db: AccountDb, userId: string): Promise<AccountExport | null> {
  const user = await db.query.users.findFirst({ where: eq(tables.users.id, userId) })
  if (!user) return null

  const [preferenceRows, lifecycleRows, auditRows, sections] = await Promise.all([
    // One read for every optional type, not one read each. isNotificationEnabled
    // is a point lookup per event type, so calling it in a loop meant three
    // round trips to answer a question about three rows in one table. The
    // default-on rule (absence of a row means enabled — see schema.ts) is
    // applied here, over whatever the single query returned.
    db.query.notificationPreferences.findMany({
      where: eq(tables.notificationPreferences.userId, userId),
      columns: { eventType: true, enabled: true },
    }),
    db.query.lifecycleSends.findMany({
      where: eq(tables.lifecycleSends.userId, userId),
      orderBy: desc(tables.lifecycleSends.sentAt),
      columns: { stepId: true, sentAt: true },
    }),
    db.query.auditLog.findMany({
      where: and(eq(tables.auditLog.targetType, 'user'), eq(tables.auditLog.targetId, userId)),
      orderBy: desc(tables.auditLog.createdAt),
    }),
    collectSections<ReturnType<typeof getAccountContributors>[number], AccountExportSections>(
      getAccountContributors().filter((c) => c.exportSection),
      (c) => c.exportSection?.(db, userId) ?? Promise.resolve(undefined),
    ),
  ])

  const overrides = new Map(preferenceRows.map((row) => [row.eventType, row.enabled]))
  const notificationPreferences = OPTIONAL_NOTIFICATION_EVENT_TYPES.map((eventType) => ({
    eventType,
    enabled: overrides.get(eventType) ?? true,
  }))

  return {
    exportedAt: new Date().toISOString(),
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      role: user.role,
      provider: user.provider,
      signupSource: user.signupSource,
      signupMedium: user.signupMedium,
      signupCampaign: user.signupCampaign,
      signupReferrer: user.signupReferrer,
      referralCode: user.referralCode,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    },
    notificationPreferences,
    lifecycleEmails: lifecycleRows.map((row) => ({
      step: row.stepId,
      sentAt: row.sentAt.toISOString(),
    })),
    auditEntries: auditRows.map((row) => ({
      action: row.action,
      actorType: row.actorType,
      createdAt: row.createdAt.toISOString(),
    })),
    ...sections,
  }
}
