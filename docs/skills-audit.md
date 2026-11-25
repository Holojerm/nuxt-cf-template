# Skills pack audit

The template carried 84 skills (83 under `.agents/skills/`, plus `.claude/skills/nuxt-ui`). It now carries 14 (10 from the old pack, 4 added), each a plain copy in `.claude/skills/` pinned in `skills-lock.json` and tied in `AGENTS.md` › Agent tooling to the moment an agent loads it. Audited 2026-11-24.

## Why the pack went unused

- **Measured use was zero.** Across 425 session transcripts on the agent host (2026-11-07 to 2026-11-24, main sessions and subagents, the template and every fork), the `Skill` tool was called 54 times, never for a pack skill.
- **Most of the pack was invisible.** Claude Code lists `.claude/skills/` only. That held 16 symlinks into `.agents/skills/` plus `nuxt-ui`, and those 17 appeared in the skill listing of about 270 sessions each. The other 67 never reached a session.
- **Nothing pointed at them, and their descriptions gave no trigger.** No instruction file named a pack skill at a moment of work. The vendored designer-skill descriptions said what each skill was ("Design loading, skeleton, and progressive content reveal patterns") but never when to use it. Upstream has since added "Use when" lines, and this refresh picks them up.

Context cost was never the problem: the 17 listed entries were about 640 tokens a session.

## What changed

- Kept 10 skills (below), all refreshed to upstream through `bunx skills add` so the lock records source, commit and hash, and `bunx skills update -p -y` works.
- `web-design-guidelines` 1.1.0 now reads a pinned copy of the guidelines (`references/command.md`, upstream commit `434b7f9`) instead of fetching `main` at run time.
- `nuxt-ui` moved to upstream's current layout (guidelines, recipes and layouts references, 2026-10-28).
- `.agents/skills/` and the symlinks are gone: one directory, real files. The pack went from 479 files and about 10.2 MB to 52 files and 456 KB, with all four additions included.
- Each kept skill has a row in `AGENTS.md` › Agent tooling, and the `growth-review`, `marketing-content`, `seo-content` and `bug-fix` routines name the skill they load.
- Licences and copyright lines for every source are in `.claude/skills/THIRD_PARTY_NOTICES.md`. The old pack shipped none of its MIT notices.
- `DESIGN.md` wins over every design skill. `frontend-design` already defers to "the brief", and `AGENTS.md` says the brief is `DESIGN.md`.

## Kept from the old pack

| Skill | Source | Moment | Why |
| --- | --- | --- | --- |
| `nuxt-ui` | nuxt/ui (MIT) | Building or changing a page or component | The only stack-specific skill. v4-correct (`UFieldGroup`, `UNavigationMenu`, `app.config.ts` › `ui.colors`, `@import "@nuxt/ui"`) |
| `frontend-design` | anthropics/skills (Apache-2.0) | A new page or a redesign | Names the generic-AI tells to avoid and asks for a plan reviewed against the brief before code. It defers to the brief, which here is `DESIGN.md` |
| `web-design-guidelines` | vercel-labs/agent-skills (MIT) | Before calling UI work done | A `file:line` review against about 100 interface rules. Now pinned, so it works offline |
| `design-qa-checklist` | Owl-Listener/designer-skills (MIT) | Before calling UI work done | The full state matrix (hover, focus, active, disabled, empty, loading, error), touch targets, truncation, real content. Agents tend to ship the happy path |
| `state-machine` | Owl-Listener/designer-skills | A form, wizard or multi-step flow | Lists states for form, fetch, auth and wizard flows, with no impossible pairs (loading and error) and no dead ends |
| `loading-states` | Owl-Listener/designer-skills | A view that fetches, submits or saves | Duration tiers (under 100 ms nothing, up to 1 s subtle, up to 10 s clear, longer shows progress), no layout shift, optimistic updates that roll back |
| `error-handling-ux` | Owl-Listener/designer-skills | A view that fetches, submits or saves | Error placement by context (field, form, page, network, permission), input kept on error, what-happened/why/what-next copy, no "Something went wrong" |
| `feedback-patterns` | Owl-Listener/designer-skills | A view that fetches, submits or saves | Feedback nearest the action, errors persist, undo over "are you sure", never colour alone. Toast timing must stay pausable (WCAG 2.2.1) |
| `ux-writing` | Owl-Listener/designer-skills | Interface or landing copy | Verb-first labels, the three-part error, empty states that lead to an action. Its neutral-voice defaults yield to `DESIGN.md` |
| `a-b-test-design` | Owl-Listener/designer-skills | Proposing or judging a growth bet | Hypothesis form, one primary metric plus guardrails, no peeking, and "don't test at very low traffic", which fits these apps. The routine's 100-per-arm thresholds win |

Some upstream descriptions point to skills we don't carry (`handoff-spec`, `form-design`, `doherty-threshold`). Those pointers are harmless.

## Cut

Shortlist picks overturned on reading: `accessibility-audit` only restates the WCAG headings, and axe plus `design-qa-checklist` already cover it. `responsive-design` uses 375/640/1024/1440 breakpoints, which are not Tailwind's. `dark-mode-design` prescribes `#121212` and off-white text against a fork's palette. `metrics-definition` is a generic HEART taxonomy, and `a-b-test-design` covers the primary and guardrail metrics. `playwright-ui-testing` drives a `playwright-cli` binary and `/test-*` commands that this repo doesn't have.

| Skill | Source | Reason |
| --- | --- | --- |
| `algorithmic-art` | anthropics/skills | p5.js generative art; no product use |
| `brand-guidelines` | anthropics/skills | Applies Anthropic's brand, not a fork's |
| `canvas-design` | anthropics/skills | Poster and art renderer; 5.6 MB of fonts |
| `claude-api` | anthropics/skills | Sessions have a built-in `claude-api`; the vendored copy pinned stale model ids |
| `doc-coauthoring` | anthropics/skills | Generic document workflow; no licence file upstream |
| `docx`, `pdf`, `pptx`, `xlsx` | anthropics/skills | Duplicates of skills every session has; about 3.4 MB together |
| `internal-comms` | anthropics/skills | Company status reports; consumer apps with no team |
| `mcp-builder` | anthropics/skills | Python and Node MCP SDK guide; the `mcp/` Worker is built differently |
| `skill-creator` | anthropics/skills | Duplicates the built-in |
| `slack-gif-creator` | anthropics/skills | No product use |
| `template-skill` | anthropics/skills | Empty placeholder |
| `theme-factory` | anthropics/skills | Themes for slides and docs; `DESIGN.md` owns theme |
| `web-artifacts-builder` | anthropics/skills | React and shadcn artifacts, not Nuxt pages |
| `webapp-testing` | anthropics/skills | Python Playwright with `networkidle` waits; the repo's suites are TypeScript |
| `playwright-ui-testing` | az9713/playwright-ui-testing | Needs a CLI and commands this repo lacks; 1 star upstream |
| `accessibility-audit` | Owl-Listener/designer-skills | WCAG headings only; axe and `design-qa-checklist` cover it |
| `accessibility-test-plan` | Owl-Listener/designer-skills | Needs screen-reader sessions and real users |
| `affinity-diagram`, `card-sort-analysis`, `click-test-plan`, `diary-study-plan`, `empathy-map`, `interview-script`, `summarize-interview`, `test-scenario`, `usability-test-plan` | Owl-Listener/designer-skills | Research activities that need real participants or transcripts |
| `case-study`, `presentation-deck`, `stakeholder-alignment`, `team-workflow`, `design-sprint-plan`, `design-system-adoption`, `design-review-process`, `design-critique` | Owl-Listener/designer-skills | Portfolio, meeting and org-process artifacts for a design team |
| `design-brief`, `design-rationale`, `documentation-template`, `handoff-spec`, `component-spec`, `pattern-library`, `wireframe-spec`, `user-flow-diagram`, `prototype-strategy` | Owl-Listener/designer-skills | Documents for a human handoff; here the agent writes the code |
| `journey-map`, `experience-map`, `jobs-to-be-done`, `user-persona`, `north-star-vision`, `opportunity-framework`, `competitive-analysis` | Owl-Listener/designer-skills | Strategy artifacts; personas without research are fabrication |
| `color-system`, `typography-scale`, `spacing-system`, `layout-grid`, `theming-system`, `design-token`, `design-token-audit`, `dark-mode-design`, `illustration-style`, `icon-system`, `design-principles` | Owl-Listener/designer-skills | Invent taste or token schemes that `DESIGN.md`, Tailwind v4 `@theme` and NuxtUI semantic colours already own; several contradict them (non-Tailwind breakpoints, `icon-` names against `i-lucide-*`) |
| `responsive-design` | Owl-Listener/designer-skills | Non-Tailwind breakpoints; its good checks are in `design-qa-checklist` and the a11y suite |
| `visual-hierarchy`, `heuristic-evaluation` | Owl-Listener/designer-skills | Theory a capable model already applies (Nielsen's ten, one primary action) |
| `animation-principles`, `micro-interaction-spec`, `gesture-patterns` | Owl-Listener/designer-skills | Motion character is `DESIGN.md`'s; the apps have almost no custom gestures |
| `data-visualization` | Owl-Listener/designer-skills | Sessions have a stronger built-in `dataviz` skill |
| `metrics-definition` | Owl-Listener/designer-skills | Generic taxonomy; `fleet.json` › `product` defines the metrics |
| `naming-convention`, `version-control-strategy` | Owl-Listener/designer-skills | Figma naming and file versioning; they contradict the repo's Vue and git conventions |

`skills-lock.json` also listed a `contributing` skill from nuxt/ui that was never on disk. It is gone.

## Gap research

Signals were read 2026-11-24 from the GitHub API (`gh api repos/<owner>/<repo>`: stars, last push, licence) and from skills.sh's per-skill all-time install counts. skills.sh shows no date and its counts are unaudited. Treat them as relative, not absolute.

**Most-installed skills overall** (skills.sh): `frontend-design` (anthropics, 1.2M), `vercel-react-best-practices` (931K), `web-design-guidelines` (903K), `vercel-composition-patterns` (472K), `ui-ux-pro-max` (471K), superpowers `brainstorming` (442K), `skill-creator` (442K), `impeccable` (433K), superpowers `systematic-debugging` (347K). The two most-installed skills that fit this stack are already kept. The Owl-Listener pack this template vendored has about 3K installs per skill (262K across 111 skills), flat across skills, which points to whole-pack installs.

**Packs checked**

| Pack | Stars | Last push | Licence | Fit |
| --- | ---: | --- | --- | --- |
| anthropics/skills | 200K | 2026-11-16 | Apache-2.0 per skill (Office skills since 2026-11-06) | `frontend-design` kept; the rest are built-in or off-stack |
| obra/superpowers | 326K | 2026-11-24 | MIT | Process skills; `systematic-debugging` added |
| coreyhaines31/marketingskills | 62K | 2026-11-24 | MIT | Most-installed SEO and copy skills; `seo-audit` and `copywriting` added |
| pbakaus/impeccable | 116K | 2026-11-24 | Apache-2.0 | Design-command vocabulary; overlaps `frontend-design` and brings its own taste |
| vercel-labs/agent-skills | 35K | 2026-11-20 | MIT (README) | `web-design-guidelines` kept; the rest are React- or Vercel-specific |
| cloudflare/skills | 3.4K | 2026-11-24 | Apache-2.0 | `workers-best-practices` added; the rest are in the Cloudflare plugin |
| stripe/ai | 2.1K | 2026-11-24 | MIT | `stripe-best-practices` (104K installs), in the Stripe plugin |
| microsoft/playwright-cli | 15K | 2026-11-24 | Apache-2.0 | `playwright-cli` (227K installs) drives a CLI browser; it doesn't write TypeScript specs |
| PostHog/skills | 80 | 2026-11-24 | MIT | `creating-experiments`, `instrument-feature-flags` (521 KB); the repo says it is under construction |
| resend/resend-skills | 219 | 2026-11-19 | MIT | `email-best-practices` (60 KB) |
| antfu/skills | 6.1K | 2026-11-11 | MIT | `nuxt` (148 KB, 25K installs), `vue`, `nitro` |
| trailofbits/skills | 8.4K | 2026-10-23 | CC-BY-SA-4.0 | Security review; share-alike, so not for an MIT template |
| Owl-Listener/designer-skills | 3.5K | 2026-11-19 | MIT | The source of seven kept skills |

**Added** (approved 2026-11-24, each with an `AGENTS.md` row and a routine pointer):

| Skill | Source, licence | Size | Signal | Moment | What it changes here |
| --- | --- | --- | --- | --- | --- |
| `systematic-debugging` | obra/superpowers, MIT | 6 files, 40 KB | 347K installs | A bug or failing test, before proposing a fix; the `bug-fix` routine | Root cause before any fix, with a trace-back method and a test-polluter finder. Nothing built-in does this |
| `workers-best-practices` | cloudflare/skills, Apache-2.0 | 5 files, 40 KB | 155K installs | Writing or reviewing `server/` code or `wrangler.toml` | Interactive sessions have it through the Cloudflare plugin. Cloud routines and fresh fork sessions don't. Its Apache text is in the notices file |
| `seo-audit` | coreyhaines31/marketingskills, MIT | 92 KB (evals kept, so the copy matches the lock) | 266K installs | The `seo-content` routine; any new public content page | A technical and on-page audit beyond `seo:check`: indexing, canonicals, titles, Core Web Vitals |
| `copywriting` | coreyhaines31/marketingskills, MIT | 80 KB (evals kept) | 267K installs | Landing and marketing copy; the `marketing-content` routine | Conversion copy where `ux-writing` covers interface copy. Its rule that every claim must be supportable matches the routines' honest-output rule |

**Referenced, not vendored**

- `stripe-best-practices`: billing changes are rare and need the owner, and sessions that make them have the plugin.
- PostHog `creating-experiments`: the repo is under construction, and flags here go through `scripts/flags.ts`.
- `playwright-cli`: needs its CLI installed.
- antfu `nuxt`: overlaps `AGENTS.md` and the `nuxt` MCP. Revisit if Nuxt 4 mistakes recur.
- Resend `email-best-practices`: revisit at the next email build.
- Cloudflare `web-perf`: in the plugin.
- impeccable: overlaps `frontend-design` and brings its own taste.

**Gaps left open**

- **Browser tests.** No published skill writes TypeScript Playwright and axe specs. The `AGENTS.md` row points at `test/a11y/accessibility.spec.ts`. Write a short skill of our own once a session gets a spec wrong.
- **Email.** No Maizzle or mustache skill exists. `.claude/docs/email.md` stays the guide.
- **D1 and Drizzle migrations.** No vendor skill exists. The `/db-migrate` command covers them.
- **Security review.** Use the built-in `/security-review`. No permissive skill with real traction exists.
- **Mobile with Expo.** A fork-level choice, not the template's. Vercel's `react-native-skills` (289K installs) is the candidate.

## Re-measure on 2026-12-08

On the agent host, count `Skill` calls by name since this change landed:

```bash
cd ~/.claude/projects && find . -name '*.jsonl' -newermt 2026-11-25 -print0 \
  | xargs -0 grep -ho '"name":"Skill","input":{"skill":"[^"]*"' \
  | sed 's/.*"skill":"//;s/"$//' | sort | uniq -c | sort -rn
```

For each kept skill, also count the sessions that listed it:

```bash
find . -name '*.jsonl' -newermt 2026-11-25 -print0 | xargs -0 grep -l -- 'n- loading-states: ' | wc -l
```

Cloud routine runs leave no transcript on the host. For those, check whether the routine's PRs show the skill's checks.

A kept skill with no load in the window is cut, unless no session in the window did the work its moment names. In that case it gets one more window.
