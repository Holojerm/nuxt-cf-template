# Referrals

The referral layer (`layers/referral/`): an invite link per account, welcome days for the person who
arrives on one, a reward for the person who sent them once the newcomer first pays, and the clawback of
that reward if the payment reverses.

> **Load this when:** touching `layers/referral/`, anything that grants days nobody paid for, the `?ref=`
> capture, or the share card. Billing context is in [billing.md](billing.md).
> Canonical index: [AGENTS.md](../../AGENTS.md).

---

## What is where

| | Where |
| --- | --- |
| Policy: welcome, reward, caps, self-referral, the clawback's audit rows, the summary | `layers/referral/server/utils/referral.ts` |
| Codes: generate, collision, resolve a claimed code to its holder | `layers/referral/server/utils/referral-codes.ts` |
| Ref vocabulary: `referral_<refereeId>`, `welcome_<salted mailbox hash>` | `layers/referral/server/utils/referral-refs.ts` |
| Account creation: a code per account, `referred_by`, the welcome days | `layers/referral/server/utils/referral-signup.ts` |
| Reactions to a Paddle event: reward, clawback paperwork | `layers/referral/server/utils/referral-billing.ts` |
| `referral` / `referralKind` on the billing view | `layers/referral/server/utils/referral-view.ts` |
| Optional durable "trial spent" record, for an app that hard-deletes entitlements | `layers/referral/server/utils/referral-ledger.ts` (`registerWelcomeLedger`) |
| Registration with core | `layers/referral/server/plugins/referral.ts` |
| `GET /api/referral/me`, the share card | `layers/referral/server/api/referral/me.get.ts`, `layers/referral/app/components/Referral/ShareCard.vue` |
| Prices and the stacking sentence | `layers/referral/shared/utils/referral.ts` |
| **Stays in core** | the `users.referral_code` / `users.referred_by` and `magic_link_tokens.referral_code` columns (the app's schema; the layer ships no migration); the code shape (`shared/utils/referral-code.ts`) and the `?ref=` claim in the first-touch cookie (`shared/utils/attribution.ts`); the `referral.*` audit actions and the `referral` notification class; `getIdentitySalt()` |

## The seams (core's, so no layer imports another)

| The loop needs | Through | Without the other side |
| --- | --- | --- |
| A code per account, `referred_by` from the visitor's cookie, the welcome days after sign-in | `registerSignupContributor` (`server/utils/signup-contributors.ts`) | no billing: codes and attribution still work, the welcome days are not granted (`unavailable`) |
| To be paid when money arrives, and to record the clawback | `registerBillingOutcomeHandler` (`server/utils/billing-outcome.ts`) | no billing: the webhook never runs, so nothing is paid |
| To write, stack, find and count days | `getEarnedAccess()` (`server/utils/earned-access.ts`); billing registers the provider | no provider: `unavailable`, logged `referral_*_skipped`, never an error; the share card still shows the code and `referredCount`, with `rewardedCount` 0 |
| Its fields on the billing view | `registerEntitlementViewFields` (`server/utils/entitlement-view-fields.ts`) | no loop: the billing view has no `referral` fields at all |

Billing keeps only the generic parts: the `earned_from_ref` cascade (revoke or restore any row that exists
because of a purchase), stacking, and `entitlements`. It never names a referral.

A referral reward is access nobody paid for, granted automatically, on a signal
from outside the building. Treat `layers/referral/server/utils/referral.ts` as billing code.

- **The referee's welcome grant is small and the referrer's reward is not, and
  that asymmetry is the anti-fraud design.** A grant at signup costs its
  recipient one fresh mailbox, so whatever `REFERRAL_WELCOME_DAYS` is, that is
  the price of the product to anyone willing to rotate addresses — hence 7 days
  rather than a whole pass. The referrer is paid `REFERRAL_REWARD_DAYS` only
  when the referee **first pays**, observed in the webhook. Never move the
  referrer's trigger to signup, and never raise the welcome grant to a full pass.
- **Three things hold that cost story up, and all three are load-bearing.**
  Remove any one and farming the loop becomes cheaper than buying the product:
  1. **The reward is revoked when the PURCHASE behind it reverses.** Keyed on
     `entitlements.earned_from_ref` — the transaction, never the person, or a
     refund of somebody's second pass claws back the reward their first earned.
     For a subscription that means its **first transaction**
     (`entitlements.first_transaction_id`, which Paddle sends once on
     `subscription.created`), not the `sub_` id: a refund of a later renewal
     names the renewal's transaction, finds no reward keyed on it, and claws
     nothing back. It still closes the buyer's current period (any approved
     refund ends access), and the next paid period reopens it — see the
     ordering bullet below. Only when Paddle never sent a transaction id does
     the reward fall back to the subscription id, and then a renewal refund
     does cascade.
     The cascade follows the **buyer's own row**, never the adjustment's
     `full`/`partial` label: that field is nullish in the schema and Paddle
     labels an item-level 100% refund `partial`, so keying on it failed open.
     Whenever the buyer's row is actually revoked, the reward goes with it.
     **Revoking the reward row alone takes nothing away** — rewards stack, so
     the rows above it still cover those days. The clawback measures the
     revoked window's unspent remainder (from `period_start`) and slides every
     row stacked on top of it down by that much; a chargeback the merchant
     later **wins** restores the row from `restore_period_end` and slides the
     stack back up. A reversal restores only when the buyer's own row is being
     reinstated (a `txn_` row still reading `chargeback`; a `sub_` row not
     reading `refunded`), and it restores the buyer's `txn_` pass too, since no
     Paddle lifecycle event ever will. The cascade lives inside
     `revokeForAdjustment` (`layers/billing/server/utils/entitlements.ts` ›
     `revokeDerivedEntitlements`), not in the webhook route, so every caller
     gets it; the route only writes the audit rows.
  2. **The cap counts revoked rows.** Refund-churn burns budget instead of
     recycling it; counting only live rows would make the ceiling unreachable.
  3. **Self-referral is judged by mailbox, not address** (`isSameMailbox`), so
     `me+1@gmail.com` on `me@gmail.com`'s code is refused.
- **The welcome grant is once per MAILBOX, not once per account.** Its ref is
  `welcome_<saltedHash('referral-welcome:v1:' + canonical mailbox)>`. Keyed on
  the user id it was renewable forever by deleting the account and signing up
  again on the same address.
- **That salt is provisioned, never configured** (`server/utils/identity.ts`,
  `instance_secrets`): 32 random bytes written to D1 on first use and never
  rotated. It is deliberately not `sessionPassword` — an operator may rotate
  that after a compromise, and rotating it would recompute every mailbox's ref
  and silently re-arm every spent trial. It is deliberately not a new env var
  either, for the reason `unsubscribe.ts` gives: a new secret is a human gate,
  and the fork that never sets it is the fork that gets the bug. The digest is
  domain-separated because unprefixed it was byte-identical to the magic-link
  per-address rate-limit key. `grantRefereeWelcome` also checks the pre-2026-08-22
  ref during transition; delete that once no legacy row can still be granting.
- **Idempotency is structural.** There is no ledger table and no "already paid"
  flag, because both need a read-then-write a webhook redelivery can race.
  Each grant derives a deterministic ref (`layers/referral/server/utils/referral-refs.ts`) and the
  unique index on `paddle_subscription_id` refuses the second write. So the
  webhook hook is called on *every* qualifying event: a redelivery is a repair
  path, not a second payout. The cap is the one soft edge — it is read-then-write,
  so the true ceiling is `REFERRAL_MAX_REWARDS` plus in-flight deliveries.
- **The two prefixes are counted differently.** `REFERRAL_MAX_REWARDS` counts
  `referral_` rows only; a person's own `welcome_` row must not eat the budget
  they earn with. That is the whole reason they are not one prefix.
- **`rewardedCount` on the share card counts rewards that still STAND**
  (`countStandingReferralRewards`), while the cap counts every payout ever
  triggered including revoked ones (`countReferralRewards`). Two queries on
  purpose: showing a clawed-back reward as "earned you days" sends somebody
  looking for days that are not there, and letting a refund refund the budget
  slot makes the cap unreachable.
- **A live subscriber IS paid** — unlike a comp, which still refuses. A comp is
  an apology an operator chooses to send; a referral reward was earned by
  somebody the product already promised. The days stack from the renewal date
  and start when the subscription ends, and the share card says exactly that.
  Refusing lost the reward permanently (the trigger never retries) and did it to
  the referrers most worth having. Self-referral and tombstoned referrers are
  still refused, and every skip is logged.
- **"First paid" for a subscription is a status transition, not money** —
  `previousStatus === null || 'trialing'`. `past_due → active` is a dunning
  recovery, not a first payment. It is not keyed on `transaction.completed` with
  a `subscription_id` because `applyPaddleEvent` classifies that as `ignored`
  with no userId; see the reasoning at the webhook call site. The clawback is
  the backstop for what a status cannot distinguish.
- A `?ref=` code lands in the existing **first-touch** attribution cookie
  (`shared/utils/attribution.ts`), so a returning visitor cannot be re-credited
  to whoever sent them the most recent link. The layer's signup contributor
  turns it into `users.referred_by` on the INSERT branch of `upsertOAuthUser`,
  and only when it resolves to a real, live, other account. A magic link carries the code on its **token row**
  (`magic_link_tokens.referral_code`), so a link requested on a laptop and
  opened on a phone still attributes; `readAttributionCookie()` is the same-browser
  backstop for rows minted before that column, and may only ever fill a hole,
  never overwrite one.
- Every grant writes a `referral.rewarded` audit row with `actorType: 'system'`.
  Ids and day counts only — never a code or an address.

## Vendoring it into a fork

`bun run layers:pull referral`, then, in one commit:

1. **Billing must be vendored too** if the loop is to grant anything (it registers the earned-access
   provider). Without it the layer still works as above and grants nothing.
2. **Delete the fork's own copies** of everything the layer now holds (its referral files under `server/utils/`,
   `server/plugins/`, `server/api/referral/`, `shared/utils/` and `app/components/Referral/`, and their tests). A
   layer util wins over an app file of the same name and cannot be shadowed. Take the core files that changed in the
   same release: `server/utils/{signup-contributors,earned-access,billing-outcome,entitlement-view-fields,users,auth,extensions}.ts`,
   `shared/utils/{referral-code,attribution}.ts`. The fork's own `users.ts` / `auth.ts` lose their referral
   code; the signup seam replaces it.
3. **Schema**: the layer ships no table, so nothing is re-exported and `bunx drizzle-kit generate` must say
   "No schema changes". A fork's own referral-adjacent table stays app-owned. The case that needs one: an app
   whose account deletion **removes** entitlement rows loses the `welcome_` row with the account, which re-arms
   the trial for the same address. It keeps a durable record of its own (never touched by the deletion
   batch, never pruned) and registers it with `registerWelcomeLedger({ spent, markSpent })` from a Nitro plugin.
   The layer asks `spent` first and calls `markSpent` only after the days are written; see the header of
   `layers/referral/server/utils/referral-ledger.ts`. The template retains entitlements on deletion, so it
   needs none.
4. **Customised UI** is shadowed, not edited: an app component of the same name (`Referral/ShareCard`, under the
   app's `app/components/`) wins over the layer's. The numbers on it come from the layer's shared referral
   constants (`REFERRAL_WELCOME_DAYS`, `REFERRAL_REWARD_DAYS`, `REFERRAL_STACKING_NOTE`).
5. **Anything the fork changed in the reward or welcome path** (a different "has this mailbox had its trial"
   check, say) cannot be done by editing the layer: raise it as an option upstream, or keep the fork's loop
   app-owned.
6. Run the billing replay (`bun run billing:replay`) on the fork's `origin/main` build and on the vendoring
   branch and diff the dumps; `--no-referral` leaves the loop out for a fork without it.
