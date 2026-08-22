# Scaffold API Route

Create a new server API route following the project's conventions.

## Usage
`/scaffold-api [path] [method?]`

Examples:
- `/scaffold-api workouts` → creates `server/api/workouts.get.ts`
- `/scaffold-api workouts/[id] put` → creates `server/api/workouts/[id].put.ts`
- `/scaffold-api workouts post` → creates `server/api/workouts.post.ts`

Default method is `get` if not specified.

## Before writing the file — pick the gate

Every route needs exactly one of these, and choosing wrong is the most expensive
mistake available here. Ask if it isn't obvious from the request:

| Gate | Use for | Throws |
| --- | --- | --- |
| `await requireUserSession(event)` | Signed-in, free functionality | 401 |
| `await requireSubscription(event)` | **Anything you sell** | 401 / 402 |
| `await requireAdmin(event)` | Owner-facing endpoints | 401 / 403 |
| none — add to the allowlist | Genuinely public (see below) | — |

**`requireSubscription()` is the real paywall.** `app/middleware/subscription.ts`
runs in the browser and only decides which page renders; delete it and the API
still refuses. Skip the server call and the gate is decorative — a signed-in
free user can `fetch()` the route directly. If the feature is behind a plan,
this line is not optional.

Public routes need an explicit entry in `server/middleware/auth.ts` — the global
guard 401s everything under `/api/` that isn't allowlisted. Scope it by method
where possible (the feedback rule is `path === '/api/feedback' && method === 'POST'`,
so reading the queue stays gated). Anything public and unauthenticated should also
take a `rateLimit(event, { name, limit, windowSeconds })`.

## Instructions

Create the file at `server/api/[path].[method].ts`.

### GET route (read)

```typescript
// One or two lines on why this route exists and who calls it — every route in
// server/api/ carries this. Note anything non-obvious about the gate.

import { z } from 'zod'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

export default defineEventHandler(async (event) => {
  // 1. Gate — see the table above
  const { user } = await requireUserSession(event)

  // 2. Route params (dynamic routes only)
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'Missing id' })

  // 3. Validated query
  const query = await getValidatedQuery(event, querySchema.parse)

  // 4. Read. `db` and `schema` are auto-imported by @nuxthub/core — never
  //    import or instantiate Drizzle, and never call hubDatabase() directly.
  const row = await db.query.workouts.findFirst({
    where: and(eq(schema.workouts.id, id), eq(schema.workouts.userId, user.id)),
  })

  if (!row) throw createError({ statusCode: 404, message: 'Workout not found' })

  // 5. Shape the response explicitly. Dates are Date objects in Drizzle and
  //    must be serialized — return exactly the fields the client needs rather
  //    than spreading the row, so a column added later isn't leaked by default.
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
  }
})
```

### POST / PUT / PATCH route (mutation)

```typescript
// Why this route exists.

import { z } from 'zod'

// Schema at module scope, not inside the handler.
const bodySchema = z.object({
  name: z.string().min(1).max(100),
})

export default defineEventHandler(async (event) => {
  // Paid functionality: this is the boundary, not the client middleware.
  const { user } = await requireSubscription(event)

  const body = await readValidatedBody(event, bodySchema.parse)

  const row = await createWorkout(db, { userId: user.id, ...body })

  return { id: row.id, createdAt: row.createdAt.toISOString() }
})
```

### Where the logic goes

Anything with real branching — money, entitlements, quota, multi-step writes —
belongs in `server/utils/*.ts` as a function taking the Drizzle client as its
**first argument**, not inline in the handler. That's what lets the workerd
vitest suite drive it against a real D1 binding without booting Nitro. See
`server/utils/entitlements.ts` and `test/entitlements.test.ts` for the pattern.

Handlers stay thin: gate, validate, call, shape.

### Rules

- **File naming**: `[path].[method].ts` — the method suffix IS the HTTP method
- **Pick a gate deliberately** — `requireSubscription()` for anything you sell
- **`db` and `schema` are auto-imported** — never `useDB()`, never `hubDatabase()`, <!-- refs-check-ignore: names the deprecated APIs a fork must NOT use -->
  never a manual `drizzle()` call
- **Reference tables as `schema.<table>`** in routes (server utils that import
  the schema module directly use `tables.<table>` — follow the file you're in)
- **Always validate input with Zod** — `readValidatedBody` for bodies,
  `getValidatedQuery` for query strings, schema declared at module scope
- **No `any` types** — use Zod-inferred types or the `$inferSelect` exports
- **Always `createError({ statusCode, message })`** — never throw raw errors
- **Serialize dates** with `.toISOString()`; return an explicit shape, not the raw row

After creating the file, output:
- The full file path and HTTP method
- Which gate you chose and why
- The Zod schema fields the user should customize
- Whether `server/middleware/auth.ts` needs an allowlist entry
