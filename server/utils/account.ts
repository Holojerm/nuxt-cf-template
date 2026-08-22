// Self-serve account deletion and data export — exactly what /privacy
// promises, no more: "deletion of your account and its contents", "a copy of
// your data", billing records kept as tax law requires.
//
// Like server/utils/entitlements.ts and server/utils/audit.ts, every function
// here takes the Drizzle client as its first argument rather than reaching for
// the auto-imported `db`, so test/account.test.ts can drive it against a real
// D1 binding without booting Nitro. For the same reason, anything this file
// calls that Nitro would normally auto-inject (`blob`) is imported explicitly
// — nothing is injected outside a real Nitro request (see CLAUDE.md › Gotchas
// on `kv`, which has the identical failure mode).
//
// ── Anonymize the row, don't erase it ────────────────────────────────────────
// `users.id` has to survive: `entitlements.user_id` is a real foreign key, and
// entitlement rows are the billing history /privacy says is kept for tax law.
// Erasing the row would either violate that constraint or orphan the
// entitlements it's attached to. So "delete the account" means: scrub every
// personally-identifying column on the `users` row in place, and hard-delete
// everything that exists only to serve this person directly.
//
// ── What "contents" means for feedback ───────────────────────────────────────
// A feedback row's `message` is product feedback the person chose to leave —
// content ABOUT the app, not content IN it, the same distinction that keeps an
// audit row about them from being erasable. So the message stays; what gets
// scrubbed is the PII riding alongside it — `email`, `user_agent`, `ip_hash`.
// `feedback.user_id` is deliberately not touched: it was never a foreign key
// (see schema.ts), so once the `users` row above is anonymized it already
// points at nobody identifiable, and leaving it is what keeps "how many
// distinct people gave feedback" answerable without keeping a name attached.

import { and, count, desc, eq } from 'drizzle-orm'
import type { drizzle } from 'drizzle-orm/d1'
import { blob } from '@nuxthub/blob'
import * as tables from '../db/schema'
import type { AuditMetadata } from '../db/schema'
import { isBillingLive } from './entitlements'
import { isSubscriptionRef } from './paddle-refs'
import { withAudit } from './audit'
import { isNotificationEnabled } from './notifications'
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

/**
 * Is there a subscription behind this account that Paddle might still bill —
 * across every product it might have bought, not just `'default'`.
 *
 * Deliberately NOT `getBillingOverview(db, userId)`, which scopes to one
 * `productKey`. A deployment that sells more than one product could have a
 * live subscription on a non-default key, and the one guard in this file that
 * exists to stop a customer getting billed after deletion must not miss it.
 * Per-account row counts are small, so one unfiltered read plus an in-memory
 * scan is simpler and safer than threading every product key through here.
 *
 * ── Billing-liveness, not access ─────────────────────────────────────────────
 * This used to key on ACTIVE_STATUSES, which is the rule for "does this grant
 * access". Wrong question, and wrong in the expensive direction: `past_due` and
 * `paused` grant no access and are exactly the two states that go on to charge
 * a card — one when a dunning retry succeeds, one when the customer unpauses.
 * A `past_due` account could therefore delete itself, and then renew. See
 * isBillingLive() in server/utils/entitlements.ts.
 */
async function findLiveSubscriptionRef(db: AccountDb, userId: string): Promise<string | null> {
  const rows = await db
    .select({
      paddleSubscriptionId: tables.entitlements.paddleSubscriptionId,
      status: tables.entitlements.status,
    })
    .from(tables.entitlements)
    .where(eq(tables.entitlements.userId, userId))

  const live = rows.find(
    (row) => isSubscriptionRef(row.paddleSubscriptionId) && isBillingLive(row.status),
  )
  return live?.paddleSubscriptionId ?? null
}

export interface DeleteAccountCounts {
  filesDeleted: number
  connectCodesDeleted: number
  magicLinkTokensDeleted: number
  notificationPreferencesDeleted: number
  feedbackScrubbed: number
}

export type DeleteAccountOutcome =
  | { outcome: 'not_found' }
  /** Refused — see the policy note on deleteAccount() for why this one guard exists. */
  | { outcome: 'live_subscription'; subscriptionId: string }
  | { outcome: 'deleted'; counts: DeleteAccountCounts }

/**
 * Delete a self-serve account.
 *
 * ── Refusing a live subscription is the one justified guard ─────────────────
 * Every other exit from this app is deliberately frictionless (see
 * app/utils/churn.ts) — but deleting the `users` row does not touch Paddle,
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

  const liveSubscriptionId = await findLiveSubscriptionRef(db, userId)
  if (liveSubscriptionId)
    return { outcome: 'live_subscription', subscriptionId: liveSubscriptionId }

  const [files, [connectCodeTotal], [magicLinkTotal], [notificationTotal], [feedbackTotal]] =
    await Promise.all([
      db
        .select({ id: tables.files.id, r2Key: tables.files.r2Key })
        .from(tables.files)
        .where(eq(tables.files.userId, userId)),
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
      db.select({ total: count() }).from(tables.feedback).where(eq(tables.feedback.userId, userId)),
    ])

  const metadata: AuditMetadata = {
    filesCount: files.length,
    connectCodesCount: connectCodeTotal?.total ?? 0,
    magicLinkTokensCount: magicLinkTotal?.total ?? 0,
    notificationPreferencesCount: notificationTotal?.total ?? 0,
    feedbackCount: feedbackTotal?.total ?? 0,
  }

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
      let filesDeleted = 0
      if (files.length) {
        await db.delete(tables.files).where(eq(tables.files.userId, userId))
        filesDeleted = files.length
        // Best-effort: an R2 outage (or, in tests, no R2 binding at all) must
        // not fail the deletion the person is waiting on. The orphaned objects
        // cost storage, not correctness — the row that pointed at them, and
        // soon the account itself, are already gone.
        try {
          await blob.del(files.map((file) => file.r2Key))
        } catch (error) {
          console.error(
            JSON.stringify({ kind: 'account_delete_blob_failed', userId, error: String(error) }),
          )
        }
      }

      const deletedConnectCodes = await db
        .delete(tables.mcpConnectCodes)
        .where(eq(tables.mcpConnectCodes.userId, userId))
        .returning({ id: tables.mcpConnectCodes.id })

      // Outstanding sign-in links are live credentials for this address, the
      // same class of thing as the connect codes above, and deleting an account
      // has to revoke the credentials that reach it. Without this a link minted
      // minutes earlier stays redeemable — it would create a fresh empty
      // account rather than resurrect this one (the tombstone address no longer
      // matches), but "I deleted my account and a stale email signed me into a
      // new one" is not a sentence a deletion flow should make possible.
      const deletedMagicLinkTokens = await db
        .delete(tables.magicLinkTokens)
        .where(eq(tables.magicLinkTokens.email, user.email))
        .returning({ id: tables.magicLinkTokens.id })

      const deletedNotificationPreferences = await db
        .delete(tables.notificationPreferences)
        .where(eq(tables.notificationPreferences.userId, userId))
        .returning({ id: tables.notificationPreferences.id })

      // See the file header for why the message survives and only these three
      // columns are scrubbed.
      const scrubbedFeedback = await db
        .update(tables.feedback)
        .set({ email: null, userAgent: null, ipHash: null })
        .where(eq(tables.feedback.userId, userId))
        .returning({ id: tables.feedback.id })

      await db
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
          // record, so without this watermark the phone in the other room keeps
          // full access to the entitlements this row still carries until its
          // cookie expires. See server/utils/session-guard.ts.
          sessionsInvalidBefore: new Date(),
        })
        .where(eq(tables.users.id, userId))

      return {
        outcome: 'deleted',
        counts: {
          filesDeleted,
          connectCodesDeleted: deletedConnectCodes.length,
          magicLinkTokensDeleted: deletedMagicLinkTokens.length,
          notificationPreferencesDeleted: deletedNotificationPreferences.length,
          feedbackScrubbed: scrubbedFeedback.length,
        },
      }
    },
  )
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

export interface AccountExportEntitlement {
  id: string
  paddleSubscriptionId: string
  productKey: string
  status: string
  currentPeriodEnd: string | null
  createdAt: string
}

export interface AccountExportFeedback {
  id: string
  kind: string
  message: string
  rating: number | null
  path: string | null
  status: string
  createdAt: string
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

export interface AccountExport {
  exportedAt: string
  user: AccountExportUser
  entitlements: AccountExportEntitlement[]
  feedback: AccountExportFeedback[]
  notificationPreferences: AccountExportNotificationPreference[]
  auditEntries: AccountExportAuditEntry[]
}

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

  const [entitlementRows, feedbackRows, notificationPreferences, auditRows] = await Promise.all([
    db.query.entitlements.findMany({
      where: eq(tables.entitlements.userId, userId),
      orderBy: desc(tables.entitlements.createdAt),
    }),
    db.query.feedback.findMany({
      where: eq(tables.feedback.userId, userId),
      orderBy: desc(tables.feedback.createdAt),
    }),
    Promise.all(
      OPTIONAL_NOTIFICATION_EVENT_TYPES.map(async (eventType) => ({
        eventType,
        enabled: await isNotificationEnabled(db, userId, eventType),
      })),
    ),
    db.query.auditLog.findMany({
      where: and(eq(tables.auditLog.targetType, 'user'), eq(tables.auditLog.targetId, userId)),
      orderBy: desc(tables.auditLog.createdAt),
    }),
  ])

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
    entitlements: entitlementRows.map((entitlement) => ({
      id: entitlement.id,
      paddleSubscriptionId: entitlement.paddleSubscriptionId,
      productKey: entitlement.productKey,
      status: entitlement.status,
      currentPeriodEnd: entitlement.currentPeriodEnd?.toISOString() ?? null,
      createdAt: entitlement.createdAt.toISOString(),
    })),
    feedback: feedbackRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      message: row.message,
      rating: row.rating,
      path: row.path,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    })),
    notificationPreferences,
    auditEntries: auditRows.map((row) => ({
      action: row.action,
      actorType: row.actorType,
      createdAt: row.createdAt.toISOString(),
    })),
  }
}
