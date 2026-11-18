// Whose copies are on this device. The worker keeps pages and data for whoever
// is signed in, and the outbox keeps their unsent writes; none of it may reach
// the next person. So the browser remembers which account it all belongs to,
// and everything goes the moment that is no longer who is signed in.

import { outbox } from '../../shared/utils/outbox'
import type { Outbox, OutboxIdbFactory } from '../../shared/utils/outbox'
import { PWA_OUTBOX_TAG, PWA_PERSONAL_CACHE_PREFIX } from '../../shared/utils/pwa-cache'

const OWNER_KEY = 'pwa:owner'

function readOwner(): string | null {
  try {
    return localStorage.getItem(OWNER_KEY)
  } catch {
    // Storage refused (a private window). Such a browser has no worker either.
    return null
  }
}

function writeOwner(owner: string | null): void {
  try {
    if (owner) localStorage.setItem(OWNER_KEY, owner)
    else localStorage.removeItem(OWNER_KEY)
  } catch {
    // As above.
  }
}

/** The outbox on this browser's IndexedDB, or null where there is none. */
export function browserOutbox(): Outbox | null {
  if (typeof indexedDB === 'undefined') return null
  return outbox({
    // The outbox types the part of IndexedDB it uses by hand (it also compiles
    // for the Worker, which has no DOM types), and the DOM's handler
    // signatures do not line up with those.
    indexedDB: indexedDB as unknown as OutboxIdbFactory,
    fetch: (url, init) => fetch(url, init as RequestInit),
    locks: navigator.locks,
    changed: announceOutboxChange,
  })
}

/** Tell this browser's other tabs that the outbox changed. */
export function announceOutboxChange(): void {
  if (typeof BroadcastChannel === 'undefined') return
  const channel = new BroadcastChannel(PWA_OUTBOX_TAG)
  channel.postMessage('changed')
  channel.close()
}

/**
 * Ask the worker to drop its personal caches and to stop keeping responses
 * that are still on their way. Settles when it has, or after two seconds:
 * the caches are deleted from here as well.
 */
async function tellWorkerToForget(): Promise<void> {
  const worker = navigator.serviceWorker?.controller
  if (!worker) return
  await new Promise<void>((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => resolve()
    setTimeout(resolve, 2000)
    worker.postMessage('pwa:forget', [channel.port2])
  })
}

/** Delete every personal copy on this device: kept pages, kept data, unsent writes. */
export async function forgetPwaPersonalData(): Promise<void> {
  await tellWorkerToForget()
  if (typeof caches !== 'undefined') {
    for (const name of await caches.keys()) {
      if (name.startsWith(PWA_PERSONAL_CACHE_PREFIX)) await caches.delete(name)
    }
  }
  await browserOutbox()?.clear()
  announceOutboxChange()
}

/**
 * Call with who is signed in now (null for nobody), on every load and every
 * change. `before` is who the page saw a moment ago, for a browser that cannot
 * store the owner. Clears when the copies belong to someone else, and returns
 * whether it did.
 *
 * The owner is recorded only after the clear has finished, so one cut short by
 * a page unload runs again on the next load. Nothing is cleared when nobody
 * owned the copies: a sign-in that lands on an offline route keeps the page
 * the worker has just stored for it.
 */
export async function settlePwaOwner(now: string | null, before: string | null): Promise<boolean> {
  const last = readOwner() ?? before
  if (last === now) return false
  if (last !== null) await forgetPwaPersonalData()
  writeOwner(now)
  return last !== null
}
