// POST /api/pwa/example/notes — add a note. Dev only. The shape every route
// the outbox writes to takes: session, validation, then the write inside
// `idempotent()`, so a replay of it adds nothing.
//
// The refusal is a sentence because a person may read it long after they
// wrote the note: a queued write the server rejects is shown with this message.
import { z } from 'zod'

import { idempotent } from '../../../utils/idempotency'
import { addExampleNote, requirePwaExample } from '../../../utils/pwa-example'

const noteSchema = z.object({ text: z.string().trim().min(1).max(60) })

export default defineEventHandler(async (event) => {
  requirePwaExample()
  const { user } = await requireUserSession(event)
  const body = noteSchema.safeParse(await readBody(event))
  if (!body.success) {
    throw createError({ statusCode: 400, message: 'A note is 1 to 60 characters long' })
  }
  return idempotent(event, user.id, async () => addExampleNote(user.id, body.data.text))
})
