// Price ids the e2e suite configures on its dev server AND stamps on the
// events it signs. Shared by playwright.config.ts (env) and fixtures.ts
// (events) so the two cannot drift: the webhook only grants for a price it was
// configured with, so an event carrying any other id is ignored by design.
export const E2E_PADDLE_PRICES = {
  monthly: 'pri_e2e_monthly',
  pass: 'pri_e2e_pass',
} as const
