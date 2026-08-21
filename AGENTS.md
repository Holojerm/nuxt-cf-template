# For Coding Agents

**[CLAUDE.md](./CLAUDE.md) is the canonical project-standards document.** Read it first before starting any work. It covers the tech stack, coding patterns, database setup, auth, API structure, and everything else that keeps changes consistent and prevents rework.

**[DESIGN.md](./DESIGN.md) is the source of truth for anything visual.** Color, typography, spacing, component behavior, and accessibility rules all live there. Never hand-edit generated files like `app/app.config.ts` or `app/assets/css/main.css` — they are compiled from DESIGN.md and your edits will be overwritten.

**`bun run ci` is the merge gate and must pass before any work is done.** It runs lint, design-token validation, brand-asset validation, SEO checks, typecheck, unit tests, an accessibility browser suite, and a production build. If anything in that gate fails, the code cannot merge. Fix the failure, do not work around it.

**The "Gotchas" section of CLAUDE.md documents the silent failure modes that have actually bitten this repo.** Read it before debugging. Three of them are load-bearing: the local D1 database lives in two places (only one is real), migrations are not applied on deploy (you have to run them manually), and `bun dev` caches its DB connection so external writes need a restart. Another three involve Nuxt gotchas that produce empty output rather than errors: custom `definePageMeta` keys, `nuxt-auth-utils` using `/api/_auth/` with an underscore, and `kv` not always injecting at runtime. If something appears to work but produces no output, check that section first.
