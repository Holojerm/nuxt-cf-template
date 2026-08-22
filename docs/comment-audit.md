# Comment audit — agent-context bloat

Scope: comments and JSDoc in `app/**`, `server/**`, `shared/**`, `scripts/**`, `test/**`
(`.ts`, `.vue`). 219 files. Measured 2026-08-22 at `d0b2f48`.

Token estimates are `chars / 4` throughout, per the brief. Counts come from a
string-aware scanner (it does not mistake `//` inside a string literal for a comment —
`test/seo.test.ts:339` contains a literal `'2026-06-18<!--'` that a naive scanner reads
as a 251-line comment block).

---

## Verdict first

**Do not run a general cleanup pass.** Total verified savings are **6,031 comment
tokens of 172,358 — 3.5%**. Even crediting an optimistic extrapolation into the files
below the top 20, the ceiling is around 5%.

The density is, with a small number of exceptions listed below, **correct**. Three
independent measurements say so:

| Probe | Result | Reading |
| --- | --- | --- |
| Narrative-history markers (`used to`, `was rejected`, `the first version`, …) | **70 of 11,680 comment lines — 0.6%** | The "story of how we found it" failure mode is rare, not systemic |
| Verbatim 7-gram overlap with `CLAUDE.md` | **max 1.5%** (`server/utils/referral.ts`), median <1% | Almost no copy-paste duplication; what exists is semantic and needs judgment |
| Largest comment block per file, for the brief's named heavy hitters | `entitlements.ts` 18 lines, `files.ts` 21, `users.ts` 32, `account.vue` 15, `admin/users/[id].vue` 10 | Those files are heavy by *total*, not by essay drift — many small comments on specific decisions, which is the healthy pattern |

Two things are worth doing regardless of the bloat decision:

1. **The four `DEAD-POINTER` findings** — those are bugs in the docs, not style.
2. **The section-banner trim** (§3) — 2,796 tokens, purely decorative, zero judgment
   required. This is 46% of the total available saving and carries no risk at all.

Everything else is a 3,235-token prose saving spread across 28 blocks in 13 files, each
needing individual review. My recommendation is to take the ~10 largest (§4, findings
T1–T10, 1,636 tokens) if anyone is touching those files anyway, and leave the rest.

---

## 1. Summary table

| Directory | Files | Comment lines | Total lines | Ratio | Comment tokens | Projected saving | After | Reduction |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `server/` | 88 | 6,071 | 12,880 | 47.1% | 89,979 | 4,103 | 85,876 | 4.6% |
| `test/` | 54 | 2,039 | 11,632 | 17.5% | 32,817 | 487 | 32,330 | 1.5% |
| `app/` | 50 | 1,974 | 7,689 | 25.7% | 29,805 | 1,072 | 28,733 | 3.6% |
| `scripts/` | 14 | 693 | 2,621 | 26.4% | 10,368 | 291 | 10,077 | 2.8% |
| `shared/` | 13 | 668 | 1,370 | 48.8% | 9,390 | 78 | 9,312 | 0.8% |
| **Total** | **219** | **11,445** | **36,192** | **31.6%** | **172,358** | **6,031** | **166,327** | **3.5%** |

`app/ + server/ + shared/` alone is 8,713 comment lines of 21,939 = **39.7%**, matching
the brief's 39% figure. The whole-scope figure is lower because `test/` sits at 17.5%.

Split of the saving: **2,796 (46%) decorative banners · 3,235 (54%) prose.**

### Where the tokens actually are

The single largest cost centre is not any one file — it is the **file-header preamble**,
the block an agent pays unconditionally on every file open before reading a line of code:

| Preamble size | Files | Comment tokens |
| --- | ---: | ---: |
| 40+ lines | 11 | 8,965 |
| 25–39 lines | 30 | 14,608 |
| 15–24 lines | 53 | 14,746 |
| 8–14 lines | 75 | 11,392 |
| 1–7 lines | 45 | 3,360 |
| **Total** | **214** | **53,071 — 31% of all comment tokens** |

I audited all 11 of the 40+ preambles and 9 of the 25–39 band. **Most of them earn their
keep**: `server/api/auth/apple.ts:1-56` (907 tok) is five distinct silent-failure gotchas
back to back and I propose cutting none of it. The finding here is not "preambles are
bloat" — it is that if anything is ever trimmed, this is the band to trim, because it is
the only comment class with a 100% read rate.

---

## 2. `DEAD-POINTER` findings — fix these regardless

Four comments name a file or symbol that does not resolve. An agent trusts these and
goes hunting. Fix cost is one line each.

### D1 · `shared/utils/referral.ts:93` — **high severity, money code**

```
 * be refunded, which is why the reward is revoked when the referee's money goes
 * back (server/utils/referral.ts › revokeReferralRewardForReferee).
```

Wrong twice over: **`revokeReferralRewardForReferee` does not exist anywhere in the
repo**, and the mechanism it describes lives in a different file. The real cascade is
`revokeDerivedEntitlements`, called from `revokeForAdjustment`, both in
[server/utils/entitlements.ts:441](server/utils/entitlements.ts:441) and
[:568](server/utils/entitlements.ts:568). `CLAUDE.md` states the correct location; this
comment contradicts it.

**Fix:** `(server/utils/entitlements.ts › revokeDerivedEntitlements, called from revokeForAdjustment).`

### D2 · `app/types/seo.d.ts:3-4`

```
// The alternative — hardcoded path lists inside server/routes/sitemap.xml.ts
// and server/routes/llms.txt.ts — is two more places to remember. They get
```

Neither file exists. The real routes are
[server/routes/sitemap.xml.get.ts](server/routes/sitemap.xml.get.ts) and
[server/routes/llms.txt.get.ts](server/routes/llms.txt.get.ts). The `.get` suffix is the
Nitro method convention, so the names are not interchangeable.

**Fix:** add `.get` to both.

### D3 · `test/csp/csp.spec.ts:67`

```
 * looked at. app/plugins/zod-jitless.client.ts now sets `z.config({ jitless:
 * true })`, which is zod's own switch for exactly this case, and the probe no
```

The file is [app/plugins/00.zod-jitless.client.ts](app/plugins/00.zod-jitless.client.ts).
The `00.` prefix is **load-bearing** — that plugin's own header (lines 26–35) explains
the flag must be set before the first `z.object(...)` is evaluated, which is what the
numeric ordering prefix buys. A comment that drops the prefix hides the one detail that
matters most about the filename.

**Fix:** add the `00.` prefix.

### D4 · `server/api/mcp/connect-code.post.ts:2`

```
// worker's /authorize page exchanges it for an OAuth grant (see mcp/README.md).
```

`mcp/` contains `bun.lock`, `package.json`, `src/`, `tsconfig.json`, `wrangler.jsonc` —
no README. The identity bridge is documented at `README.md:1184` and implemented in
[mcp/src/authorize.ts](mcp/src/authorize.ts).

**Fix:** `(see mcp/src/authorize.ts).`

### D5 · `server/db/schema.ts:387` — minor, directional

```
//   3. The write must never fail. Same reasoning as `feedback.user_id` below:
```

`feedback` is defined at [server/db/schema.ts:317](server/db/schema.ts:317), *above*
`audit_log` at line 391. "below" sends the reader the wrong way in a 571-line file.
(Note `schema.ts:89` says "below" of the same target and is correct — it is at line 89.)

**Fix:** `above`.

---

## 3. Section banners — 2,796 tokens, zero judgment required

288 comment lines carry a decorative box-drawing rule, e.g.

```
// ── Why this is a thin wrapper and not its own write path ────────────────────
```

**303 dash runs, 12,091 characters, average run 39.9 chars, longest 67.** The *title*
carries information; the run of `─` after it carries none. Trimming every run to a
3-character stub saves **2,796 tokens** and deletes no words.

`chars/4` materially **understates** this one: BPE tokenizers split runs of box-drawing
characters far worse than 4:1, so the real saving is likely 2–4× the figure quoted.

| Directory | Runs | Chars | Saving |
| --- | ---: | ---: | ---: |
| `server/` | 172 | 6,408 | 1,473 |
| `app/` | 53 | 2,597 | 610 |
| `test/` | 55 | 2,114 | 487 |
| `scripts/` | 16 | 639 | 148 |
| `shared/` | 7 | 333 | 78 |
| **Total** | **303** | **12,091** | **2,796** |

⚠️ **One banner must not be touched**: [app/layouts/default.vue:137](app/layouts/default.vue:137)
ends a multi-line HTML comment whose final line carries `design-check-ignore`. See §6.

This is the only finding in the report I would apply mechanically.

---

## 4. Ranked `TIGHTEN` findings — measured replacements

Each replacement below was written out and measured. Savings are `before − after`, not
estimates. Ordered by saving.

### T1 · `server/utils/referral.ts:124-159` · `TIGHTEN` · **saves 251** (553 → 302)

36-line JSDoc on `planReferralGrant`. Opens:

```
/**
 * Work out what a grant would do, without writing anything.
```

Two passages are narrative history of fixes that already landed: lines 133–135 ("This
used to refuse whenever a subscription was already granting access, copied from
grantCompPasses(). It was the wrong rule in the wrong place") and lines 148–152 ("The old
worry — that the granted row outranks the subscription in findActiveEntitlement's
`ORDER BY current_period_end DESC` … was fixed independently in entitlement-view.ts").

**Replacement:**

```
/**
 * Work out what a grant would do, without writing anything.
 *
 * Split from the write so the caller can decide — and audit — before acting;
 * audit.ts's policy is that the row describes intent and is written first.
 *
 * ── A live subscriber IS paid, unlike a comp ─────────────────────────────────
 * Do NOT copy grantCompPasses()'s refusal here. A comp is an apology an operator
 * chooses to send; a referral reward was already EARNED by somebody who read
 * "you get 30 days when they pay" and went and did it. Refusing costs them the
 * reward permanently (the trigger is one-time and never retries) and fails
 * precisely the referrers most worth having, who are overwhelmingly already
 * paying. So the days are written, stacked from the running expiry — for a
 * subscriber, their renewal date — and the share card says exactly that.
 *
 * The stacking base is `overview.active`, the longest-running granting row,
 * rather than the subscription: if a pass runs past the renewal, stacking on the
 * renewal throws away days the customer already holds. A `sub_` row with no
 * `current_period_end` starts today.
 */
```

*Nothing lost:* the rule, the reason, and the negative constraint all survive — the
replacement states the "do not copy the comp refusal" instruction more directly than the
original, which buried it in past tense.

### T2 · `server/utils/audit.ts:14-35` · `TIGHTEN` · **saves 238** (350 → 112)

22 lines elaborating why audit-before-act beats act-then-record, with a bulleted
comparison to `sendEmail()` and a cost paragraph. Opens:

```
// The alternative — act first, then record, and swallow a failed insert the way
// sendEmail() swallows a failed send — is the wrong trade here, and the two
```

The policy itself is already stated in full at lines 9–12. Lines 28–31 explicitly
cross-reference the `audit_log` table comment for the same reasoning.

**Replacement:**

```
// The alternative — act first, then record, and swallow a failed insert the way
// sendEmail() does — is the wrong trade here. A dropped email is an
// inconvenience; a dropped audit row is the disappearance of the only evidence
// that an admin reached into someone else's account. A refused grant is visible
// immediately, an unrecorded one is invisible forever. Cost, accepted: D1 being
// down takes the admin console's mutations with it.
```

*Nothing lost:* the asymmetry that justifies the policy, and the accepted cost, both
survive; only the three-paragraph development of them goes.

### T3 · `server/db/schema.ts:519-544` · `TIGHTEN` · **saves 202** (414 → 212)

26-line preamble to `instanceSecrets`. Opens:

```
// Instance secrets — server-generated derivation salts, one row each.
//
// ── Why this exists rather than another env var ──────────────────────────────
```

Lines 521–538 are a near-complete restatement of
[server/utils/identity.ts:1-29](server/utils/identity.ts:1), which is the canonical
argument and says so. Third copy of the same reasoning (the other is
`referral.ts:408-416`).

**Replacement:**

```
// Instance secrets — server-generated derivation salts, one row each.
//
// Why a table and not an env var: see server/utils/identity.ts, which has the
// full argument. In short, the referral welcome trial's salt must be STABLE
// FOREVER — its once-per-mailbox invariant is a deterministic ref meeting a
// unique index, so a changed salt silently re-arms every spent trial.
//
// ── What may and may not live here ───────────────────────────────────────────
// Server-generated derivation material ONLY. Never user input, never anything
// rendered, never anything a request can name — an id here is chosen by code in
// this repo, so this can never become a key/value store a handler writes into.
// It holds no personal data and is not exported.
```

*Nothing lost:* the schema-specific rule ("what may live here") is untouched; the salt
rationale becomes a pointer to the file that owns it.

### T4 · `server/utils/referral.ts:24-51` · `TIGHTEN` · **saves 167** (434 → 267)

28 lines of the file header. Opens:

```
// ── What each half costs an attacker, stated honestly ────────────────────────
// This is the part that was wrong in the first version of this file, which
```

Lines 25–34 narrate that an earlier version of the comment was wrong. The three
anti-fraud pillars (lines 36–46) are load-bearing and stay verbatim.

**Replacement:**

```
// ── What each half costs an attacker ─────────────────────────────────────────
// Without all three of the following, a referee could buy the $18 pass, collect
// the referrer's 30 days, and refund the same day — repeated through `+1`, `+2`
// sub-addresses of one inbox. All three are load-bearing:
//
//   * The reward is REVOKED when the PURCHASE behind it is fully refunded or
//     charged back — keyed on `entitlements.earned_from_ref`, so it is the
//     transaction that is undone rather than the person. The cascade lives in
//     entitlements.ts so every caller of revokeForAdjustment gets it.
//   * The cap counts revoked rows too, so refund-churn burns budget rather than
//     recycling it — see countReferralRewards.
//   * Self-referral is judged by MAILBOX, not address (users.ts › isSameMailbox).
//
// What remains: two distinct mailboxes and one kept purchase, for 30 days on one
// of them. Break-even, bounded by REFERRAL_MAX_REWARDS, and audited.
```

*Nothing lost:* the attack, all three defences, and the residual cost all survive. Only
"the previous version of this comment was wrong" goes — which is true of every comment
that was ever edited and is not a fact about the code.

### T5 · `server/utils/referral.ts:401-422` · `TIGHTEN` · **saves 154** (382 → 228)

22 lines inside `grantRefereeWelcome`'s JSDoc, in two sections
(`Once per mailbox…`, `The salt is provisioned…`). Both restate the file header
(lines 53–56) and `identity.ts`. Opens:

```
 * ── Once per mailbox, not once per account ───────────────────────────────────
 * The ref is keyed on a salted hash of the canonical mailbox rather than on
```

**Replacement:**

```
 * ── Once per mailbox, not once per account ───────────────────────────────────
 * The ref is keyed on a salted hash of the canonical mailbox rather than on
 * `user.id`, because a user id is renewable and an inbox is not: deleting an
 * account frees its address, and an id-keyed ref hands out the trial again,
 * forever. See referralWelcomeRef().
 *
 * The salt comes from getIdentitySalt(), NOT `sessionPassword` — rotating that
 * secret would recompute every mailbox's ref and silently re-arm every spent
 * trial. server/utils/identity.ts has the argument. `sessionPassword` is still
 * passed in for one job: recognising refs minted under the old construction.
 *
 * Re-resolves the referrer rather than trusting `users.referred_by`: one indexed
 * read, and it is the only place the referrer's id is available for the audit row.
```

*Nothing lost:* both invariants and the `NOT sessionPassword` warning survive intact.

### T6 · `app/composables/useFlag.ts:28-52` · `TIGHTEN` · **saves 150** (432 → 282)

25 lines on `settled`. Opens:

```
// ── `settled` ──────────────────────────────────────────────────────────────
// A caller that only ever renders the value gets to ignore this. It exists for
```

Lines 32–42 make one point — posthog returns `undefined` deterministically until
`/flags` resolves, so watching for a *change* never fires — in three successive framings.

**Replacement:**

```
// ── `settled` ────────────────────────────────────────────────────────────────
// A caller that only renders the value can ignore this. It exists for one-shot
// side effects — recording which arm a visitor saw, exactly once
// (server/utils/onboarding.ts › recordActivationOnce).
//
// Such an effect must NOT be gated on "the value changed". posthog-js's
// `getFeatureFlag`/`isFeatureEnabled` return `undefined` deterministically —
// not a stale-then-corrected pair — until the `/flags` round trip completes.
// For a cold-cache visitor that is EVERY mount, not a race: the ref never leaves
// the fallback within the window a watcher sees, so nothing is observed to
// change and the effect never fires.
//
// `settled` means: PostHog has reported flags for this page load, or is
// confirmed to have nothing to report (unconfigured or blocked). Bounded by
// FLAGS_SETTLE_TIMEOUT_MS so it cannot wedge false. Gate on
// `settled && <condition>`, never on watching the value change.
```

*Nothing lost:* the failure mode, why it is deterministic rather than a race, and the
prescription all survive.

### T7 · `app/pages/dashboard.vue:109-123` · `TIGHTEN` · **saves 142** (265 → 123)

15 lines that re-derive the posthog-flags argument a **third** time (after
`useFlag.ts:1-52` and `useFlag.ts:28-52`). Opens:

```
// A `watch` over `[settled, complete]` with `immediate: true`, not an
// `onMounted` callback plus a separate `watch(variant, …)`. The two used to
```

**Replacement:**

```
// A `watch` over `[settled, complete]` with `immediate: true`, NOT an
// `onMounted` callback plus a separate `watch(variant, …)`. Firing from
// `onMounted` fires before the flag has necessarily resolved, and `variant`
// merely changing is not a reliable proxy for that — see
// app/composables/useFlag.ts › `settled` for why. One watcher over the two real
// preconditions also re-evaluates correctly after handleFeedbackSubmitted's
// refresh flips `progress.value.complete` live.
```

*Nothing lost:* the negative constraint stays first-class; the mechanism becomes a
pointer to the file that owns it.

### T8 · `server/utils/auth-providers.ts:52-66` · `TIGHTEN` · **saves 137** (251 → 114)

15 lines duplicating [server/api/auth/apple.ts:27-37](server/api/auth/apple.ts:27), which
is the fuller and better-placed account of the same nuxt-auth-utils bug. Opens:

```
      // Five values, and every one of them is load-bearing.
      //
```

I verified the underlying claim against the installed library: `apple.js:27` uses
`config.redirectURL || getOAuthRedirectURL(event)` for the authorize URL but `apple.js:62`
sends the raw `config.redirectURL` in the token exchange. **The comment is accurate** —
this finding is about which of the two copies survives, not about correctness.

**Replacement:**

```
      // Five values, and every one is load-bearing. Apple has no static client
      // secret: the server signs a short-lived ES256 JWT per request from a .p8
      // key (teamId/keyId/privateKey). `redirectURL` is required here and is the
      // one that is impossible to debug from the symptom — see the full account
      // in server/api/auth/apple.ts. Requiring it means the button never appears
      // unless the flow can actually complete.
```

*Nothing lost:* `apple.ts` keeps the full diagnosis, including the library version and
the `invalid_grant` symptom; this site keeps the reason the check exists.

### T9 · `server/utils/referral.ts:193-215` · `TIGHTEN` · **saves 123** (345 → 222)

23-line JSDoc on `writeReferralGrant`. Opens:

```
/**
 * Write one planned grant. Idempotent on the ref, by the unique index.
```

A genuine negative constraint (do not switch to `DO UPDATE`) developed over five
paragraphs.

**Replacement:**

```
/**
 * Write one planned grant. Idempotent on the ref, by the unique index.
 *
 * ── DO NOTHING, never grantPass's DO UPDATE ──────────────────────────────────
 * grantPass() infers "did this insert land?" by comparing the date it computed
 * against the date returned by an upsert. That inference breaks on welcome
 * grants: they land on an empty account, so the date is always `now + 7 days`,
 * recomputed identically on every attempt — two attempts in the same second
 * produce the same truncated timestamp and a conflict that wrote nothing is
 * reported as a fresh grant. The row stays correct; the RETURN VALUE lies, in
 * the direction of "we just gave this person a trial".
 *
 * `DO NOTHING … RETURNING` has no inference in it: SQLite returns a row when it
 * inserted one and none when it skipped.
 */
```

*Nothing lost:* the constraint is now in the section heading rather than four lines in.

### T10 · `app/pages/dashboard.vue:40-51` · `TIGHTEN` · **saves 72** (191 → 119)

This is the brief's own canonical example, and it is here verbatim:

```
// Read-only, fetched exactly once. `watch: false` is the load-bearing part:
// without it, any reactive value this call happened to reference would make
// useFetch refetch on the client after the flag resolves in onMounted, and
// this page used to pass `variant` as a query param for exactly that reason
// — which meant every load fetched twice. GET /api/onboarding no longer
// takes a variant at all (it's a pure read now — see that file and
// server/utils/onboarding.ts for why), so there's nothing left to react to,
// but `watch: false` stays as the explicit guarantee rather than an
// accident of there being no reactive params left to trip over.
```

**Replacement:**

```
// Read-only, fetched exactly once. `watch: false` is load-bearing: without it,
// any reactive value this call references would make useFetch refetch on the
// client after the flag resolves in onMounted, double-fetching every load.
// GET /api/onboarding takes no params now, so nothing is left to react to —
// this stays as the explicit guarantee rather than an accident.
//
// `refresh` IS used, deliberately not destructured-away: see
// handleFeedbackSubmitted below.
```

*Nothing lost:* the constraint and the reason it stays despite being currently
unreachable both survive; the discovery story goes.

**T1–T10 subtotal: 1,636 tokens.**

---

## 5. Remaining findings — smaller, same pattern

Measured `before`; `after` estimated at the stated compression. Listed for completeness;
I would not spend a review cycle on these unless already editing the file.

| # | Location | Verdict | Before | Save | Why nothing is lost |
| --- | --- | --- | ---: | ---: | --- |
| S1 | `server/utils/admin-grants.ts:141-155` | TIGHTEN | 256 | ~151 | Lines 141–147 narrate a `/account` labelling bug the comment itself says was fixed elsewhere; the refusal rule and the "name the right instrument" guidance stay |
| S2 | `server/db/schema.ts:268-283` | TIGHTEN | 269 | ~129 | Restates the cross-device argument made 12 lines earlier at 248–256; the money-vs-marketing distinction and the not-a-FK rule stay |
| S3 | `app/composables/useFlag.ts:3-6` | **CUT** | 66 | 66 | Explains what feature flags are for in general — tutorial voice, zero repo-specific content |
| S4 | 7 sites: "db comes in as first arg so tests drive real D1 in workerd" — `entitlements.ts:3`, `audit.ts:3`, `magic-link.ts:9`, `notifications.ts:9`, `admin-grants.ts:8`, `account.ts:6`, `session-guard.ts:124` | TIGHTEN | ~350 | ~200 | Keep one canonical statement; the rest become a clause. Do **not** cut entirely — it prevents a refactor to the auto-imported `db` that would break every test |
| S5 | `server/utils/referral.ts:684-692` + `767-775` + `779-785` | TIGHTEN | 341 | ~170 | Three blocks in one file explaining that the two counts answer different questions; one canonical statement plus two pointers |
| S6 | `server/utils/rate-limit.ts:15-30` | TIGHTEN | 291 | ~91 | Caveat 2 (the quoted Cloudflare line) restates caveat 1; the per-colo trade-off keeps its point in two lines instead of six |
| S7 | `server/db/schema.ts:176-192` | TIGHTEN | 279 | ~94 | The not-composite decision and the SQLite `LIKE`/`ESCAPE` interaction both stay; the justification narrows |
| S8 | `scripts/seed.ts:33-42` | TIGHTEN | 176 | ~86 | Keep "reuses the webhook's own `upsertSubscription()` so the row shape can't drift"; the driver-agnosticism paragraph is inferable from the code |
| S9 | `server/utils/admin-grants.ts:312-319` | TIGHTEN | 139 | ~84 | "A `comp_` row has no Paddle side, so nothing else can end one early" is the whole content; the hand-written-SQL anecdote is not |
| S10 | `server/utils/session-guard.ts:3-15` | TIGHTEN | 224 | ~84 | The revocation mechanism stays; the pre-fix symptom list compresses |
| S11 | `server/db/schema.ts:3-13` | TIGHTEN | 134 | ~74 | snake_case conventions are visible in the code below; the append-only `updated_at` rule is the only non-obvious line and stays |
| S12 | `server/utils/session-guard.ts:68-75` | TIGHTEN | 149 | ~64 | The allowlist and the `GET /api/_auth/session` carve-out are untouched; three worked symptom examples become one |
| S13 | `server/utils/referral.ts:445-449` | TIGHTEN | 100 | ~65 | Verbatim repeat of `legacyWelcomeRefForEmail`'s own JSDoc 60 lines up; becomes a pointer |
| S14 | `server/utils/email.ts:41-47` | TIGHTEN | 115 | ~60 | "Ignores rather than throws, and logs loudly" carries it; the inbox-provider elaboration does not |
| S15 | `scripts/seed.ts:11-14` | TIGHTEN | 77 | ~57 | Narrative ("The first version of this script seeded two users"); **the seed-user table at 18–25 must stay** — it is reference data, not prose |
| S16 | `server/utils/audit.ts:52-57` | TIGHTEN | 109 | ~49 | The no-PII rule stays; the client-side-filtering aside goes |
| S17 | `server/utils/admin-grants.ts:344-348` | TIGHTEN | 98 | ~43 | "`already_expired` writes nothing, because moving a past date forward rewrites history" is the rule; the "used to" framing is not |
| S18 | `app/pages/admin/users/[id].vue:33-36` | TIGHTEN | 77 | ~32 | Keep "fails silently in both directions"; drop "It used to be re-typed here as `MAX_PASSES = 12`" |

**S-subtotal: ~1,599 tokens. §4 + §5 prose total: 3,235.**

---

## 6. Do not touch

Adjudicated and deliberately kept. This list exists so the next reviewer does not
re-litigate it.

### 6a. Functionally load-bearing — deleting these breaks `bun run ci` or changes behaviour

I verified how each gate treats comment text:

- **`seo:check` strips comments before applying rules** (`scripts/check-seo.ts:66`, used
  at `:84`), and there are **zero** `seo-check-ignore` directives in source. Comment
  edits cannot affect it.
- **`mirror:check` compares behaviour, not text** — it extracts each function and
  evaluates it (`scripts/check-mirrors.ts:10-15`). Comment edits cannot affect it.
- **`design:check` reads comments as escape hatches** and scans `app/**` for
  `.vue`/`.ts`/`.css` (`scripts/check-design-tokens.ts:18-19`, `:207-208`). **12 comments
  are load-bearing here**, plus one lint directive.

| Location | Directive | Note |
| --- | --- | --- |
| `app/pages/design-system.vue:15-25` | `design-check-ignore` ×11 | Deliberate raw-scale swatches on the token-preview route |
| `app/layouts/default.vue:137` | `design-check-ignore` | ⚠️ **Fragile.** It sits on the *last line of a multi-line HTML comment*, and the gate matches "same line or the line above" the offending code at `:138`. Shortening that comment block by even one line breaks the build |
| `server/utils/auth.ts:44` | `eslint-disable-next-line no-control-regex` | Not a gate, but removing it fails lint |

### 6b. Adjudicated as earning their keep

| Location | Size | Why it stays |
| --- | ---: | --- |
| `server/api/auth/apple.ts:1-56` | 907 tok | Five distinct silent-failure gotchas (no `.get` suffix, four-value config, required redirect URL, Hide My Email identity split, SameSite=Lax limitation). I verified the library claim at `apple.js:27` vs `:62` — it is correct. Cut nothing |
| `server/utils/session-guard.ts:17-32` | ~250 tok | The "why not a KV cache" argument. `CLAUDE.md` explicitly points *here* as the canonical home, and this is the exact refactor an agent would otherwise make — a cache that fails open reintroduces the bug |
| `server/db/schema.ts` index rationales (`:98-104`, `:288-305`, `:462-470`) | ~600 tok | Each names a query that full-scans without the index, and a `LIMIT` that bounds rows deleted rather than examined. Pure silent-degradation-as-you-grow |
| `server/utils/admin-grants.ts:321-339` | ~330 tok | "Comps only" + "both status and date must be set". Ordering/atomicity the code cannot express, on access-control code |
| `scripts/seed.ts:44-53` | ~180 tok | `grantCompPasses()` calls `db.batch()`, which bun-sqlite does not have — it would **throw**, not merely diverge. Prevents an obvious "reuse the helper" refactor |
| `scripts/seed.ts:18-25` | ~140 tok | The seed-user table. Reference data an agent cannot derive; not prose |
| `server/utils/email.ts:29-39` | ~200 tok | List-Unsubscribe must never appear on billing/security mail, enforced twice on purpose. Deliverability + security invariant |
| `server/utils/referral.ts:58-63`, `:648-668` | ~330 tok | Structural idempotency, and "the cap counts revoked rows" — the anti-churn property. Money semantics |
| `server/utils/entitlements.ts`, `server/utils/files.ts`, `server/utils/users.ts` (all blocks) | ~11k tok | Largest block in each is 18/21/32 lines. Many small comments on specific decisions — the healthy pattern, no essay drift found |
| `app/plugins/00.zod-jitless.client.ts:26-35` | ~200 tok | Why module scope and why the `00.` prefix. Removing the prefix silently reintroduces a CSP violation on every page load |
| `server/tasks/purge-expired-tokens.ts:1-38` | 550 tok | The two-strings-must-match cron gotcha, which fails with no error and no log line |
| `server/utils/identity.ts:1-29` | 456 tok | Canonical home for the salt argument. T3 and T5 above make it *more* canonical by pointing here |
| All 288 section-*titles* | — | Only the `─` runs after them are proposed for trimming (§3). The titles are navigation |

---

## 7. Method notes and limits

- **Measurement.** A string-aware scanner classifies every line; `//` inside a string
  literal is not a comment. Cross-checked against the brief's stated 39% for
  `app/+server/+shared` (I measure 39.7%).
- **Dead-pointer sweep.** Every file path, `symbol()`, backticked identifier, `›`-form
  reference and `NUXT_*`/`CLOUDFLARE_*` env var in every comment was extracted and
  resolved against a **comment-stripped** corpus (so a symbol that exists only inside
  other comments does not falsely resolve), plus `package.json` scripts, migration
  filenames, and `node_modules` for library-internal paths. 65 candidates, 61 confirmed
  as legitimate external or hypothetical references, 4 real + 1 directional.
- **Duplication.** 7-gram shingle overlap against `CLAUDE.md` per file. Peak 1.5%.
  Semantic clusters were then identified by hand: the referral cost model, the identity
  salt, the posthog-flags argument, the Apple redirect bug, "db as first argument", and
  "deliberately NOT a foreign key" (5 sites, of which 2 already cross-reference).
- **Not covered.** I audited the top 20 files by comment tokens plus all 11 preambles of
  40+ lines and 9 of the 25–39 band — roughly 45k of the 172k comment tokens. The
  narrative-history probe (0.6% of lines, and I have covered the files holding ~30 of the
  70 marker lines) is my basis for saying the remaining 127k contains little more of the
  same. That is an inference from a proxy, not a line-by-line audit of every file.
- **CI safety.** With the 13 directives in §6a untouched, applying every finding in this
  report leaves `bun run ci` green: `seo:check` strips comments, `mirror:check` compares
  behaviour, `design:check` only reads its own escape hatch, and `lint`/`typecheck`/
  `test`/`build` do not read comment prose.
