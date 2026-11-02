import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// The billing layer's tables. NuxtHub merges every layer's server/db/schema.ts;
// the app's server/db/schema.ts re-exports this one so core's typed `db` and
// drizzle-kit see them. Migrations stay app-owned (their numbers differ per
// app), so this file must reproduce each app's existing DDL exactly:
// `bunx drizzle-kit generate` has to say "No schema changes".
//
// `user_id` references core's `users`. The import below is relative to the
// app's schema, which sits at the same path in every app; `.references()`
// takes a lazy callback, so the cycle with that file's re-export is safe.
import { users } from '../../../../server/db/schema'

// A copy of core's timestamps helper, so this file needs no app helpers.
const timestamps = {
  createdAt: integer('created_at', { mode: 'timestamp' })
    .$defaultFn(() => new Date())
    .notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date())
    .notNull(),
}

// Entitlements — one row per Paddle subscription, upserted by the webhook at
// layers/billing/server/routes/paddle/webhook.post.ts. Gate features with requireSubscription()
// (layers/billing/server/utils/billing.ts). `product_key` distinguishes plans/products when an
// app sells more than one thing ('default' otherwise).
export const entitlements = sqliteTable(
  'entitlements',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    paddleCustomerId: text('paddle_customer_id'),
    paddleSubscriptionId: text('paddle_subscription_id').notNull().unique(),
    productKey: text('product_key').notNull().default('default'),
    // Paddle subscription statuses: active | trialing | past_due | paused | canceled
    status: text('status').notNull(),
    currentPeriodEnd: integer('current_period_end', { mode: 'timestamp' }),
    // When this row's window OPENS — the end of the stack at the moment it was
    // granted (layers/billing/server/utils/entitlements.ts › stackingBase), or the grant moment
    // itself when nothing was running.
    //
    // Written by every grant path that stacks: purchased passes, comps, and
    // both referral grants. NULL on `sub_` rows (Paddle owns their period) and
    // on every row written before this column existed.
    //
    // ── Why the window has to be stored rather than inferred ───────────────────
    // The clawback removes the days a revoked row still had left, and puts
    // exactly those days back if the charge is reinstated. Both numbers are
    // `end − start`, and reconstructing `start` from whichever sibling rows are
    // ACTIVE at the time reads a different answer at revoke time than at
    // restore time whenever anything changed in between: a subscription lapsing
    // between a chargeback and its reversal would turn a 30-day restore into a
    // 60-day one, minting free access out of a dispute. A stored start is a
    // fact about the grant, so both directions read the same one no matter
    // what happened to the account meanwhile.
    periodStart: integer('period_start', { mode: 'timestamp' }),
    // ── Paddle's scheduled_change ──────────────────────────────────────────────
    // "Cancel at period end" does NOT change a subscription's status. Paddle
    // keeps it `active` and attaches `scheduled_change: { action, effective_at }`
    // until the date arrives, so a row that will never be billed again is
    // indistinguishable from one that renews next month — unless these are
    // stored. Without them the deletion guard refused, for months, to delete an
    // account whose subscription was already cancelled, and told the customer to
    // go cancel it.
    //
    // `action` is Paddle's own vocabulary (`cancel` | `pause` | `resume`), kept
    // verbatim rather than mapped to a local enum: the set is theirs to extend,
    // and a value we do not recognise should read as "something is scheduled"
    // rather than be silently dropped.
    //
    // BOTH are cleared when Paddle sends `scheduled_change: null` — that is how a
    // customer un-cancels, and a stale value here would keep an active
    // subscription looking dead forever.
    scheduledChangeAction: text('scheduled_change_action'),
    scheduledChangeAt: integer('scheduled_change_at', { mode: 'timestamp' }),
    // ── Derived entitlements ───────────────────────────────────────────────────
    // Set on a row that exists BECAUSE of another row's purchase — today only a
    // referral reward, whose ref is `referral_<refereeId>` and which Paddle has
    // therefore never heard of. This names the Paddle ref that earned it.
    //
    // Without it the clawback had to be keyed on the referee's *identity*, which
    // is the wrong key in three directions at once: a refund of that person's
    // SECOND purchase revoked the reward earned on their first, a partial refund
    // revoked a reward the money had not actually reversed, and a reward could
    // never be re-earned because nothing distinguished "which purchase was this
    // for". Keyed on the purchase, each of those answers itself.
    //
    // For a subscription it is the FIRST transaction (`first_transaction_id`),
    // not the `sub_` id: a refund adjustment names the transaction it reverses,
    // and only the first one paid for the reward.
    //
    // NULL on every ordinary row, and on referral rows granted before this column
    // existed — which is why the cascade treats NULL as "provenance unknown, do
    // not touch". A missed clawback is recoverable; clawing back a reward that
    // was legitimately earned is a support conversation with an honest customer.
    earnedFromRef: text('earned_from_ref'),
    // The window that was in force before a derived row was revoked, so the
    // revocation can be undone. A revoke sets `current_period_end = now` (both
    // halves must agree — see revokeForAdjustment), which destroys the original
    // date; a chargeback the merchant later WINS has to put it back, and
    // "recompute it" is not available once the row has been overwritten.
    //
    // NULL means "not revoked by the cascade", which is what makes it the exact
    // predicate the restore matches on — a row nobody took away cannot be
    // "restored" into a window it never had.
    restorePeriodEnd: integer('restore_period_end', { mode: 'timestamp' }),
    // `sub_` rows only: the transaction that created the subscription, which
    // Paddle sends once, on `subscription.created`. The referral reward is
    // keyed on it (`earned_from_ref`) rather than on the subscription id, so a
    // refund of a later renewal cannot claw back what the first payment earned.
    // NULL on rows created before the column and when Paddle omitted the field;
    // the reward then falls back to the subscription id.
    firstTransactionId: text('first_transaction_id'),
    // `occurred_at` of the newest Paddle event applied to this row. Paddle
    // documents out-of-order delivery, so an event older than this is refused
    // rather than allowed to overwrite a later status (see upsertSubscription).
    // NULL on rows written before the column existed and on derived rows.
    lastEventAt: integer('last_event_at', { mode: 'timestamp' }),
    ...timestamps,
  },
  (table) => [
    // Every read of this table that isn't keyed on the unique Paddle ref is
    // keyed on the owner: getBillingOverview (the /account page and the admin
    // console), the deletion guard, and countReferralRewards. Without this the
    // table was full-scanned on every one of them, and it only grows.
    //
    // Deliberately NOT composite with `product_key`. Per-account row counts are
    // tiny — a handful of purchases over a lifetime — so once the index has
    // narrowed to one user, filtering the rest in memory costs nothing, and a
    // single-column index serves the queries that don't mention product_key
    // (the deletion guard scans every product on purpose) as well as the ones
    // that do.
    //
    // It also covers the LIKE in countReferralRewards, which could not use the
    // unique index on `paddle_subscription_id` for a prefix match anyway: under
    // SQLite's rules a LIKE only becomes an index range scan for a column with
    // NOCASE collation and no ESCAPE clause, and ours has an ESCAPE clause
    // precisely because `_` is a wildcard (see server/utils/sql.ts).
    index('entitlements_user_id_idx').on(table.userId),
  ],
)

// Paddle events already applied, keyed on Paddle's `event_id`. Paddle retries
// any delivery that did not get a 2xx and operators can replay from the
// dashboard, so the webhook checks here before writing anything. Rows are
// swept by layers/billing/server/utils/billing-extensions.ts after PADDLE_EVENT_RETENTION_SECONDS.
export const paddleEvents = sqliteTable(
  'paddle_events',
  {
    eventId: text('event_id').primaryKey(),
    eventType: text('event_type').notNull(),
    occurredAt: integer('occurred_at', { mode: 'timestamp' }).notNull(),
    receivedAt: integer('received_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    // The sweep deletes by age; without this it scans the table every run.
    index('paddle_events_received_at_idx').on(table.receivedAt),
  ],
)

export type Entitlement = typeof entitlements.$inferSelect
export type NewEntitlement = typeof entitlements.$inferInsert
export type PaddleEventRecord = typeof paddleEvents.$inferSelect
