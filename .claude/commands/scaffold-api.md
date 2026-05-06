# Scaffold API Route

Create a new server API route following the project's conventions.

## Usage
`/scaffold-api [path] [method?]`

Examples:
- `/scaffold-api workouts` → creates `server/api/workouts.get.ts`
- `/scaffold-api workouts/[id] put` → creates `server/api/workouts/[id].put.ts`
- `/scaffold-api workouts post` → creates `server/api/workouts.post.ts`

Default method is `get` if not specified.

## Instructions

Create the file at `server/api/[path].[method].ts` following these conventions from CLAUDE.md:

### For GET routes (read operations)
```typescript
export default defineEventHandler(async (event) => {
  // 1. Validate route params (if dynamic route)
  const { id } = getRouterParams(event)

  // 2. Auth check
  const session = await getUserSession(event)
  if (!session.user) throw createError({ statusCode: 401 })

  // 3. Database query via Drizzle
  const db = useDB()
  const result = await db.query.[table].findFirst({
    where: eq(tables.[table].id, id),
  })

  if (!result) throw createError({ statusCode: 404, message: '[Resource] not found' })

  return result
})
```

### For POST/PUT/PATCH routes (mutation operations)
```typescript
import { z } from 'zod'

export default defineEventHandler(async (event) => {
  // 1. Auth check
  const session = await getUserSession(event)
  if (!session.user) throw createError({ statusCode: 401 })

  // 2. Validate body with Zod
  const schema = z.object({
    // fields here
  })
  const body = await readValidatedBody(event, schema.parse)

  // 3. Database mutation via Drizzle
  const db = useDB()
  // ...

  return result
})
```

### Rules
- **File naming**: `[path].[method].ts` — the method suffix IS the HTTP method
- **No `any` types** — define proper TypeScript types or use Zod-inferred types
- **Always validate body** on mutations with Zod via `readValidatedBody`
- **Always auth-check** unless the route should be public (like `/api/health`)
- **Always use `createError({ statusCode, message })`** — never throw raw errors
- **Use `useDB()`** — never access `hubDatabase()` directly

After creating the file, output:
- The full file path and HTTP method
- The Zod schema fields the user should customize (for mutation routes)
