// GET /api/pwa/example/notes — the signed-in person's notes. Dev only. The
// example app lists `/api/pwa/example` in `offlineApi`, so the worker keeps
// this answer for when there is no network.
import { listExampleNotes, requirePwaExample } from '../../../utils/pwa-example'

export default defineEventHandler(async (event) => {
  requirePwaExample()
  const { user } = await requireUserSession(event)
  return { notes: listExampleNotes(user.id) }
})
