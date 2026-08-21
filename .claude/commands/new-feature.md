# New Feature Scaffold

Scaffold a complete full-stack feature: component + API routes + optional schema changes.

## Usage
`/new-feature [FeatureName]`

Example: `/new-feature Workout`

## Instructions

Given a feature name, scaffold the full stack for that feature. Ask clarifying questions first if needed:

1. **What data does this feature manage?** (to know what schema columns/tables are needed)
2. **What operations does it need?** (list, create, update, delete — determines which API routes)
3. **Is it user-scoped or global?** (affects auth and DB query patterns)

Then execute in this order:

### 1. Schema (if new table or columns needed)

Update `server/db/schema.ts` to add the new table or columns. Follow the existing patterns:
- UUID primary keys: `.$defaultFn(() => crypto.randomUUID())`
- Spread the shared `timestamps` helper for `created_at` / `updated_at` — don't redeclare them
- Foreign keys as `<table_singular>_id` with `.references(() => users.id)`. Omit the FK
  deliberately if the row must survive a missing parent, and comment why (see `feedback.userId`)
- Add an `index()` for any column pair you filter or sort on
- Export the inferred types: `export type [Name] = typeof [table].$inferSelect`

After updating schema, remind the user to run `/db-migrate` to generate and apply the migration.

### 2. API Routes

Create the needed routes in `server/api/[feature]/`:
- `index.get.ts` — list all (scoped to current user)
- `index.post.ts` — create new
- `[id].get.ts` — get single by id
- `[id].put.ts` — update
- `[id].delete.ts` — delete

Only create the routes that are actually needed. Follow all conventions from `/scaffold-api`,
including its gate table — **ask whether this feature is part of what the product sells.** If it
is, every one of these routes opens with `await requireSubscription(event)`; the client-side
`subscription` middleware is not a boundary. Put anything with real branching in
`server/utils/[feature].ts` as a function taking `db` first, so it can be tested in workerd.

### 3. Component

Create `app/components/[Feature]/[Feature]List.vue` — the primary list/display component.
Create `app/components/[Feature]/[Feature]Form.vue` — the create/edit form using `<UForm>` with Zod schema.

Follow all conventions from `/scaffold-component`.

### 4. Page (if needed)

If the feature warrants its own page, create `app/pages/[feature]/index.vue` that:
- Uses `definePageMeta({ middleware: 'auth' })` for protected routes
- Fetches data with `const { data, status } = await useFetch('/api/[feature]')`
- Renders the List and Form components

### Summary

After scaffolding, output a checklist of what was created and what manual steps remain:
- [ ] Run `/db-migrate` if schema was changed — and remember production D1 needs
      `bun run db:migrate:remote` explicitly; deploying does not apply migrations
- [ ] Customize Zod schemas in API routes
- [ ] Confirm the gate on every new route (`requireUserSession` / `requireSubscription` / `requireAdmin`)
- [ ] Add any missing props/emits to components
- [ ] Wire up page navigation in the layout if needed
- [ ] If the page is public, add `definePageMeta({ publicPage: … })` and call `useSeo()` once —
      `bun run seo:check` fails the build otherwise
