# Database Migration

Run the full Drizzle migration workflow after schema changes.

## Usage
`/db-migrate`

## Instructions

Walk through the migration workflow step by step:

### Step 1 — Generate migration

Run:
```bash
bun run db:generate
```

This runs `drizzle-kit generate` and writes a new SQL file to `server/db/migrations/`.
After running, read the generated file and summarize what SQL it will apply.

### Step 2 — Review

Show the user the generated migration and confirm the changes look correct.
Point out anything destructive (dropped columns, changed types, added NOT NULL
without a default on a populated table).

### Step 3 — Apply locally

**Restart the dev server.** NuxtHub applies everything in `server/db/migrations/`
to its own local database (`.data/db/sqlite.db`) on boot — that is the database
`bun dev` actually serves, and applying migrations to it is not a manual step.

`bun run db:migrate` is a *different* database. It runs
`wrangler d1 migrations apply <name> --local`, which targets wrangler's sandbox
at `.wrangler/state/v3/d1/` — a path the dev server never reads. Running it is
harmless but proves nothing about local dev. (See CLAUDE.md › Gotchas › "Local
D1 lives in two places".)

If the new columns don't show up, the cause is almost always the *other* gotcha:
a running dev server keeps its own libsql connection and won't see external
writes. Restart it before debugging the query.

### Step 4 — Confirm

Verify against the database the dev server reads:
```bash
bun run db:studio
```
Report success or surface errors. If there are errors, diagnose and fix before proceeding.

### Step 5 — Production (do not skip)

**Nothing applies migrations to production D1 automatically.** `wrangler deploy`
does not run them, and NuxtHub's build-time migration step targets the local
libsql file on the build machine, not your remote database. A deploy that adds a
table ships a Worker that queries a table which does not exist.

Apply them explicitly, before or immediately after the deploy:

```bash
bun run db:migrate:remote
```

Caveat worth knowing: that script runs from the repo root, where `wrangler.toml`
declares no `migrations_table`, so wrangler tracks state in the default
`d1_migrations`. The generated `.output/server/wrangler.json` sets
`migrations_table = "_hub_migrations"`. Pick one and stay on it — alternating
between the root script and a `--cwd .output` invocation makes each one think
nothing has been applied yet.

### Notes
- Schema lives in `server/db/schema.ts` — that is the single source of truth
- Always commit the schema change AND the generated migration file together
- Never hand-edit a migration that has already been applied anywhere; generate a new one
