// POST /api/auth/dev — sign in as any email address, WITHOUT a password.
//
// ── Read this before you touch it ────────────────────────────────────────────
// This exists so `git clone && bun dev` gets you a signed-in session in ten
// seconds, instead of registering an OAuth app before you can look at a single
// gated page. It is a development affordance and a catastrophic production bug.
//
// `import.meta.dev` is replaced with a literal `false` at build time, so in a
// production bundle the guard below is `if (true) throw 404` and the rest of
// this file is dead code the bundler drops. That's the real protection — the
// runtime NODE_ENV check under it is a second lock on the same door, for the
// case where someone runs the dev server somewhere it can be reached.
//
// If you ever need real password auth, do not grow it from here. Add a proper
// provider (or a magic-link flow) and delete this file.

import { z } from 'zod'

const bodySchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100).optional(),
})

export default defineEventHandler(async (event) => {
  if (!import.meta.dev || process.env.NODE_ENV === 'production') {
    throw createError({ statusCode: 404, message: 'Not found' })
  }

  // Cheap even in dev: keeps a runaway script from filling the local users table.
  await rateLimit(event, { name: 'auth-dev', limit: 20, windowSeconds: 60 })

  const { email, name } = await readValidatedBody(event, bodySchema.parse)

  // The same reserved-address rule the magic-link endpoint enforces. Nothing
  // here is reachable in production, so this is consistency rather than
  // defence: a developer poking at a deleted account's tombstone address should
  // meet the same wall locally that a stranger would meet in production, or the
  // local behaviour teaches the wrong model. See isUndeliverableAddress().
  if (isUndeliverableAddress(email)) {
    throw createError({ statusCode: 400, message: 'Reserved address' })
  }

  const { user, created } = await establishSession(event, {
    profile: { provider: 'dev', email, name: name ?? null, avatarUrl: null },
    emailVerified: true, // there is no provider to verify against; dev only
  })

  // JSON, not a redirect: the login page calls this with $fetch and navigates
  // client-side, so it can show an inline error instead of a flash of /login.
  return { ok: true, created, user: { id: user.id, email: user.email, name: user.name } }
})
