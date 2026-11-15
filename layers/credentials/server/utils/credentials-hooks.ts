// Server hooks: what an app does when a password is replaced.
//
// A plain module registry, like server/utils/extensions.ts, so a fork registers
// from a Nitro plugin and the workerd test pool can call the same functions:
//
//   onCredentialsPasswordReset({
//     key: 'keys',
//     statements: (db, { userId }) => [db.delete(keyWraps).where(…)],
//   })
//
// `reset` fires when a mailed link set a new password: the person proved the
// mailbox, not the old password, so anything encrypted under the old unlock key
// is unreadable from here on. `change` fires when the current password was
// given, so the browser held both unlock keys and could re-wrap (the client
// hook, `credentials:unlock`, carries them).

import type { BatchItem } from 'drizzle-orm/batch'

import type { ExtensionDb } from '#server/utils/extensions'
import { createRegistry } from '#server/utils/registry'

export interface CredentialsPasswordEvent {
  userId: string
  /** The instant written to `users.sessions_invalid_before`. */
  at: Date
}

export interface CredentialsPasswordHandler {
  key: string
  /** Run in the same D1 batch as the password write: all of it lands, or none. */
  statements?: (db: ExtensionDb, event: CredentialsPasswordEvent) => BatchItem<'sqlite'>[]
  /** Run after the batch committed. A throw is logged and does not undo the reset. */
  after?: (db: ExtensionDb, event: CredentialsPasswordEvent) => Promise<void>
}

const resetHandlers = createRegistry<CredentialsPasswordHandler>()
const changeHandlers = createRegistry<CredentialsPasswordHandler>()

export const onCredentialsPasswordReset = (handler: CredentialsPasswordHandler): void =>
  resetHandlers.set(handler.key, handler)

export const onCredentialsPasswordChange = (handler: CredentialsPasswordHandler): void =>
  changeHandlers.set(handler.key, handler)

export const getCredentialsPasswordHandlers = (
  kind: 'reset' | 'change',
): CredentialsPasswordHandler[] => (kind === 'reset' ? resetHandlers : changeHandlers).values()

export function clearCredentialsHooksForTest(): void {
  resetHandlers.clear()
  changeHandlers.clear()
}
