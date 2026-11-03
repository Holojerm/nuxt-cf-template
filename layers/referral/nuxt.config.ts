// The referral layer: an invite link per account, the welcome days for the
// person who arrives on one, the reward for the person who sent them once the
// newcomer first pays, and the clawback of that reward if the payment reverses.
// The share card (Referral/ShareCard.vue), GET /api/referral/me, and the Nitro
// plugin that registers all of it with core (server/plugins/referral.ts).
//
// ── It meets the rest of the app only at core's seams ───────────────────────
// No layer imports another, and core imports none (bun run layers:check). So:
//   - a code per account, `referred_by`, the welcome days after sign-in:
//     registerSignupContributor() (server/utils/signup-contributors.ts)
//   - the reward and the clawback's paperwork on a Paddle event:
//     registerBillingOutcomeHandler() (server/utils/billing-outcome.ts)
//   - `referral` / `referralKind` on the billing view:
//     registerEntitlementViewFields() (server/utils/entitlement-view-fields.ts)
//   - writing, stacking and counting the days: getEarnedAccess()
//     (server/utils/earned-access.ts), which the billing layer registers.
// With billing absent the loop still captures codes and attributes accounts, and
// grants nothing (outcome `unavailable`). With this layer absent billing has no
// referral fields and no reward, and core is a product with no invite links.
//
// ── What stays in core, on purpose ──────────────────────────────────────────
// The `users.referral_code` / `users.referred_by` columns and the
// `magic_link_tokens.referral_code` column (the schema is the app's, and this
// layer ships no migration), and the first-touch attribution cookie's `?ref=`
// claim with its code shape (shared/utils/referral-code.ts, shared/utils/attribution.ts):
// core carries the claim, this layer decides what it is worth. The audit action
// names (`referral.rewarded` …) and the `referral` notification class are core's
// vocabulary too.
//
// ── The prices ──────────────────────────────────────────────────────────────
// Welcome days, reward days and the cap are constants in shared/utils/referral.ts,
// not options: the share card promises them and the grant enforces them, and a
// number that can differ between the two is a support ticket that reads as
// fraud. They are not configurable yet; a fork that needs other numbers asks for
// an option upstream rather than editing a vendored copy.
//
// ── No env, no runtimeConfig ────────────────────────────────────────────────
// The loop reads no environment variable of its own (the salt for the welcome
// ref is provisioned in D1, server/utils/identity.ts), so there is nothing to
// declare here. Auto-registered because it lives under layers/.
export default defineNuxtConfig({
  $meta: { name: 'referral' },
})
