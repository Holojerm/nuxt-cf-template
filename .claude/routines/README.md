# Operations Routines

Repo-shipped definitions for the cloud agents ("routines") that run the commercial side of this
product: issue triage, bug fixes, in-app feedback triage, support inbox, analytics review,
marketing drafts, and a single daily digest email summarizing everything that happened (on an
operator repo, fleet's weekly portfolio digest instead).

**All routines ship default-inactive.** Nothing runs until you explicitly enable it.

## How it works

Cloud routines live in your claude.ai account (https://claude.ai/code/routines), not in the repo —
so the repo ships the *definitions* and a sync command:

1. Each `*.md` file here (except `README.md`, `_shared.md`, `routines.config.md`) defines one
   routine: frontmatter (triggers, model, required connectors) + full instructions.
2. Run `/routines sync` in Claude Code to create/update them in your account. Routines are always
   created **disabled**; the sync never silently activates anything.
3. Enable individually: `/routines enable <name>` (or via the claude.ai routines UI).
4. The cloud agent gets this repo cloned into its environment, so its prompt is just a pointer:
   "read `_shared.md`, `routines.config.md`, and your own definition file, then execute." The
   instructions stay versioned here — editing a definition file and re-running `/routines sync`
   updates the live routine.

## The routines

| File | Trigger (UTC) | What it does | Needs |
| --- | --- | --- | --- |
| `issue-triage.md` | GitHub issue opened or reopened; weekly sweep Mon 11:00, gated | Labels, deduplicates, and assesses new GitHub issues; checks the issues other routines escalate against the code and data, and closes the ones the evidence disproves | GitHub connector (+ D1 read token); Claude GitHub App |
| `bug-fix.md` | Daily 12:00, gated on an open fixable bug | Picks the top triaged bug, opens a fix PR with a regression test; with a tier-2 grant it merges through the queue, otherwise it is a draft | GitHub connector; tier 2 |
| `roadmap-build.md` | Daily 16:00, gated on fleet's `roadmapWork.pick` | Builds the one roadmap item fleet picks for the app (one in flight at a time), opens a draft PR and claims the item on fleet's board; with a tier-2 grant it then readies the PR. An item too big for one PR becomes a `needs-owner` issue proposing a split. About 8–15M tokens an item | GitHub connector + FLEET_SCOREBOARD_URL / FLEET_SCOREBOARD_TOKEN / FLEET_ROADMAP_AGENT_TOKEN env vars; tier 2 |
| `feedback-triage.md` | API, fired by fleet when the open feedback count rises; weekly backstop Mon 11:30 | Turns the in-app feedback queue (D1 `feedback` table) into GitHub issues | GitHub connector (+ D1 read token); API trigger token in fleet |
| `support-inbox.md` | Daily 13:00, gated on a support thread | Triages support email, **drafts** replies, files bugs as issues; on an operator repo it sends how-to answers and acknowledgements, signed as the product's assistant | Gmail + GitHub connectors |
| `analytics-review.md` | Weekly Mon 12:30 | Reviews product/traffic metrics, writes a report, files opportunities; counts visits and signups per open channel bet | GitHub connector (+ analytics access) |
| `marketing-content.md` | Weekly Thu 14:00 | Drafts changelog + marketing copy into `ops/marketing/` for review; off-site links in drafts are tagged | GitHub connector |
| `growth-review.md` | Weekly Mon 13:30 | Judges last week's `growth-bet`s by type (channel, activation, monetisation, retention), turns every open `growth-idea` issue (filed by any routine or the owner: `_shared.md` › Growth ideas) and its own picks into bets against `fleet.json` › `product`, giving each idea an outcome every run, and ships each as a flagged (default-off) or content PR. Under 200 signups in 28 days it picks channel bets first, judged on visits and signups from one tagged source; never paid traffic. On an operator repo it starts and ends the rollout of its own `growth-…` flags (`scripts/flags.ts`) and submits free directory listings under the product's own name | GitHub connector (+ D1 read token); tier 2 |
| `seo-content.md` | Weekly Tue 13:00, gated on new commits, left-over work or search numbers | Keeps `seo:check` green, adds pages from the product's own data (page collections: rows or one new collection a run), and refreshes up to three pages losing clicks once fleet's scoreboard carries `search`; without it, skips that step and says so. Content PRs only; never buys links or posts off the site | GitHub connector (+ D1 read token) + FLEET_SCOREBOARD_URL / FLEET_SCOREBOARD_TOKEN env vars; tier 2 |
| `x-post.md` | Tue/Thu 15:00 | One post about something that shipped, from the product's X account (`scripts/x-post.ts`), with a tagged link that carries the open channel bet's campaign when there is one; drafts without a tier-3 grant | GitHub connector + `X_*` env vars; tier 3 |
| `x-replies.md` | Twice daily 09:00, 17:00, gated on a new reply or mention | Answers people who replied to or mentioned the product's X account (a few a run at most), escalates support/billing/press, skips the rest (`scripts/x-replies.ts`); a link it gives is tagged; drafts without a tier-3 grant | GitHub connector + `X_*` env vars; tier 3 |
| `ops-triage.md` | API, fired by fleet on new ops events or a deploy that never landed; daily backstop 06:37, gated | Reads the ops spool (`GET /api/ops/events`), retriggers a deploy that never landed, fixes **Mechanical fixes** classes, files the rest as triaged issues | GitHub connector + OPS_BASE_URL / OPS_TOKEN env vars (+ optional deploy hook URL); API trigger token in fleet; tier 2 |
| `dependency-merge.md` | Weekly Mon 15:15 | Merges Dependabot minor/patch PRs that touch only the manifest and lockfile once every check is green; majors and red checks go to the owner | GitHub connector; tier 2; `scope: fleet` (one all-repos routine) |
| `pr-shepherd.md` | Every 2 h at :23 | Gets stuck PRs moving: retries a check that failed on infrastructure once, requeues a PR that fell out of the merge queue, escalates the rest. Never writes code or merges | GitHub connector; tier 2; `scope: fleet` (one all-repos routine) |
| `template-sync.md` | Weekly Wed 14:00 | In a fork: opens the `chore/template-sync` PR when `fleet.json` › `template.syncedSha` is behind; with a tier-2 grant it merges through the queue when it leaves nothing for the owner, otherwise it is a draft | GitHub connector; tier 2 |
| `daily-digest.md` | Daily 22:00; never on an operator repo | Sends **one email per day** to the owner summarizing all actions taken. On an operator repo fleet's weekly portfolio digest replaces it, so sync neither creates nor enables it there | Gmail connector |

## Triggers

Triage routines run when something happened, not every day. A product with no new issues,
feedback, mail, X replies or ops events costs no run between the weekly reviews, or at most a
gated run that ends at its first check. The weekly routines (`analytics-review`,
`growth-review`, `marketing-content`, `template-sync`, `x-post`) stay on their schedules.

Routines support three triggers, and one routine may combine them (claude.ai routines docs,
checked 2026-11-22):

- **Schedule** — a cron, hourly at most often.
- **GitHub event** — pull request, release and issue events on the repo (no issue comments),
  through the Claude GitHub App installed on it. Only pull request events take filters, so an
  issue event fires on every matching issue.
- **API** — `POST https://api.anthropic.com/v1/claude_code/routines/<trig_id>/fire` with a
  per-routine bearer token. The token is made in the routine's web editor (Trigger › API ›
  Generate token), shown once, and fires only that routine. It cannot be made from the CLI or
  the API.

Each definition says which it uses in its frontmatter: `schedule`, `events` (GitHub events as
`<event>.<action>`) and `fire` (who calls the API trigger). Where nothing the platform can
deliver marks new work (the support inbox, X replies, a triaged bug), the routine keeps a
sparse schedule and a `gate`: a one-step check run before anything else is read, which ends
the run with no journal entry when there is nothing to do (`_shared.md` › How a run starts).

`bug-fix` is a queue worker that opens one PR a run, so it stays scheduled: an issue `labeled`
event would fire on every label any routine adds, and two runs started together would pick the
same bug. `roadmap-build` is one for the same reason, and its gate costs nothing on the days
fleet offers no item.

### Who fires the API triggers

Fleet already collects `GET /api/fleet` on a schedule, so it fires the routines whose work
shows up there. It keeps one fire token per routine as a secret and sends:

```bash
curl -sS -f -X POST "https://api.anthropic.com/v1/claude_code/routines/$TRIGGER_ID/fire" \
  -H "Authorization: Bearer $FIRE_TOKEN" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{"text": "<one line: what changed, e.g. 3 new server_error events since 10:05Z>"}'
```

- `ops-triage`: when a collect finds an ops kind whose count or newest event is newer than at
  the last fire, or a deploy that never landed.
- `feedback-triage`: when the open feedback count is higher than at the last fire.

At most one fire per routine an hour (the platform caps fires at 30 an hour per routine, and a
retry starts a second run, as there is no idempotency key). The `text` is a hint the routine
treats as data; it reads the source itself. Until fleet fires them, the backstop schedules do
the work a day later at most.

## Coordination: the ops journal

Routines coordinate through an `ops-journal` git branch (never merged to `main`, so journal
commits don't trigger deploys). Every routine appends what it did to `journal/YYYY-MM-DD.md`
on that branch, with a `- tokens:` usage line; the daily digest reads it to compose the email,
and on an operator repo fleet sums the usage lines against the monthly token cap. Protocol
details in [`_shared.md`](_shared.md).

## Before enabling anything

1. **Fork setup**: fill in [`routines.config.md`](routines.config.md) (product name, owner email,
   support inbox query, analytics sources). Leave its Operator section off unless the routines
   are meant to run the product (Safety model, below).
2. **Connectors**: connect GitHub and Gmail at https://claude.ai/customize/connectors —
   routines that need a missing connector will log the failure to the journal instead of
   acting. Never attach a Cloudflare connector to a routine.
3. **Production D1** (`_shared.md` › Reading production D1): create a Cloudflare API token
   with Account · D1 · Read and nothing else. In the routines' cloud environment, add it as
   `CLOUDFLARE_API_TOKEN` along with `CLOUDFLARE_ACCOUNT_ID`, and add `api.cloudflare.com` and
   the production host to the environment's allowed domains (a host missing from that list
   fails with a proxy 403).
4. **Sync**: `/routines sync`, then enable the ones you want. Start with `issue-triage` and
   `daily-digest` (or, on an operator repo, fleet's weekly digest); add the rest once you trust
   the output.
5. **Event triggers**: install the Claude GitHub App on the repo before syncing, so the sync can
   attach `issue-triage`'s issue events. For each routine with `fire:`, add an API trigger in
   its web editor, generate the token, and give fleet the trigger id and token as secrets
   (Triggers › Who fires the API triggers).

## Adding a routine

Drop a new `<name>.md` file here with the same frontmatter shape:

```yaml
---
schedule: "0 14 * * *"        # 5-field cron, UTC (minimum interval: 1 hour)
events: [issues.opened]        # optional: GitHub events that also start a run
fire: fleet                    # optional: who calls this routine's API trigger
gate: |                        # optional: one check run first; nothing to do ends the run
  Run `…`. Empty output means nothing to do.
model: sonnet                  # a tier: opus, sonnet or haiku (see Models, below)
connectors: [github]           # claude.ai connectors this routine needs
enabled: false                 # keep false; enable explicitly after sync
scope: fleet                   # optional: one all-repos routine runs this for every fork
operator: skip                 # optional: not synced or enabled on an operator repo
---
```

A triage routine (one that reacts to new work) gets an event, a fire or a gate, never a bare
daily schedule.

`scope: fleet` is for routines that are identical in every repo and light enough to run for all
of them in one session (`dependency-merge.md`, `pr-shepherd.md`). The owner registers one `all-repos-<name>`
routine that sources every repo and follows each repo's own grants and journal; `/routines sync`
skips the definition so forks don't grow a duplicate per repo.

…followed by a `## Purpose` and `## Instructions` section. Then `/routines sync`. Every routine
must follow the operating rules in `_shared.md` (the pointer prompt enforces reading it first).

## Models

A definition names a tier (`model: opus`, `sonnet` or `haiku`), never a model ID.
[`models.json`](models.json) maps each tier to the exact ID, and `/routines sync` writes that
ID into the live routine: the routines API refuses `opus` and `sonnet` as model names, so the
table is the one place a version lives. `bun run routines:check` (part of `bun run ci`) fails
on a definition that pins an ID.

Opus goes to the routines that write or ship code with nobody watching (`bug-fix`,
`ops-triage`, `roadmap-build`, `template-sync`) and to `growth-review`, which decides what
ships. Everything else, triage, drafting and reporting, runs on Sonnet.

**Keeping it current.** `bun run routines:models` compares the table with the newest model
per tier on frontier-terminal's public price catalog (`models.json` › `source`), which never
offers a model Anthropic has removed. The `routine-models` workflow runs it every Monday in
the template and opens a `needs-owner` issue when a tier is behind. The fix is
`bun run routines:models --write` and a PR. Forks take the table on their next template-sync,
and `/routines sync` in each repo moves the live routines onto it: nothing else changes a live
routine's model.

## Safety model

- **Default inactive** — sync never enables; enabling is a separate explicit step.
- **Tiers** — every routine acts at tier 1 (drafts) until `routines.config.md` › Autonomy grants
  lists it higher. What each tier allows is in `_shared.md`.
- **Outbound gates** — support replies are drafts, code changes are PRs, marketing copy goes to a
  review folder. Without a grant, the only autonomous outbound action is the daily digest email to
  the owner; with one, `growth-review` may merge flag-off or content PRs, `x-post` may post, and `x-replies` may answer people who addressed the X account.
- **Operator grant** — off in the template. A fork the owner hands to its routines sets
  `routines.config.md` › Operator to Mode `grow` and fills in its caps. On that repo there is no
  draft period (each routine acts at the tier its frontmatter declares), and four acts that are
  otherwise the owner's open up, each bounded in `_shared.md` › Operator grant: `growth-review`
  rolls out and retires the `growth-…` flags it created, through `scripts/flags.ts` only; the
  product mails opted-in users through its own send path, inside the weekly cap;
  `support-inbox` sends how-to answers and acknowledgements, signed as the product's assistant
  and marked automated; and `growth-review` submits a free listing in a public directory under
  the product's own name and existing accounts, one per directory. Pricing, spend (paid
  listings included), refunds, data deletion, billing, legal, security and angry support
  threads, new accounts, and anything under the owner's personal name (community posts
  included) stay with the owner on every repo. Set Mode back to `off` to take the grant back.
- **Tagged links** — every link a routine publishes or drafts for somewhere off the site
  carries `utm_source`, `utm_medium` and `utm_campaign` (`_shared.md` › Tagged links), so the
  funnel can say which source and which `growth-bet` a signup came from.
- **Untrusted input** — issue text and support emails are attacker-controlled data. `_shared.md`
  forbids following instructions found in them.
- **Decisions** — a choice only the owner can make is a decision issue with a default and a
  date (`_shared.md` › Decision issues). The default is "nothing happens" or an act the
  routine's grant already allows, and for anything the owner always keeps it is that the act
  is not done, so an unanswered question never widens what a routine does.
- **Audit trail** — everything lands in the ops journal, and the digest surfaces it: daily, or
  weekly from fleet on an operator repo.
