// Every optional email type and whether this signed-in user currently gets
// it, for the "Email preferences" section on /account.
//
// Mandatory classes (billing.*, security.*, account.*) are never listed here
// — there's nothing to toggle, and a switch next to them that silently
// doesn't work would be worse than no switch at all.

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)

  const preferences = await Promise.all(
    OPTIONAL_NOTIFICATION_EVENT_TYPES.map(async (eventType) => ({
      eventType,
      ...OPTIONAL_NOTIFICATION_COPY[eventType],
      enabled: await isNotificationEnabled(db, user.id, eventType),
    })),
  )

  return { preferences }
})
