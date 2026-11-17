// Every optional email type a switch can still affect, and whether this
// signed-in user currently gets it, for the "Email preferences" section on
// /account.
//
// Mandatory classes (billing.*, security.*, account.*) are never listed here,
// nor is mail sent only at sign-up (SWITCHABLE_NOTIFICATION_EVENT_TYPES): a
// switch that silently does nothing is worse than no switch at all.

export default defineEventHandler(async (event) => {
  const { user } = await requireUserSession(event)

  const preferences = await Promise.all(
    SWITCHABLE_NOTIFICATION_EVENT_TYPES.map(async (eventType) => ({
      eventType,
      ...OPTIONAL_NOTIFICATION_COPY[eventType],
      enabled: await isNotificationEnabled(db, user.id, eventType),
    })),
  )

  return { preferences }
})
