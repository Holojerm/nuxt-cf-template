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

This runs `drizzle-kit generate` and creates a new SQL migration file in the migrations folder.
After running, read the generated migration file and summarize what SQL changes it will apply.

### Step 2 — Review

Show the user the generated migration file contents and confirm the changes look correct.
Point out anything that could be destructive (dropping columns, changing types, etc.).

### Step 3 — Apply to local D1

Run:
```bash
bun run db:migrate
```

This runs `drizzle-kit migrate` against the local Wrangler D1 emulator.

### Step 4 — Confirm

Report success or surface any errors. If there are errors, diagnose and fix before proceeding.

### Notes
- Schema lives in `server/database/schema.ts` — that is the single source of truth
- Always commit both the schema changes AND the generated migration file together
- Production migrations run automatically on deploy via `wrangler d1 migrations apply`
- Use `bun run db:studio` to visually inspect the database after migrating
