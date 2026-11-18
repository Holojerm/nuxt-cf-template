// The browser half of a push subscription, kept out of the composable so the
// plugin can use it too.

import { base64UrlToBytes } from '../../shared/utils/push'

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/**
 * The layer's registration once its worker is active, or null. Subscribing
 * needs an active worker, and `serviceWorker.ready` never settles where
 * registration was refused (a private window), hence the time limit.
 */
export async function activePwaRegistration(
  scope: string,
): Promise<ServiceWorkerRegistration | null> {
  const registration = await navigator.serviceWorker.getRegistration(scope)
  if (!registration) return null
  if (registration.active) return registration
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
  ])
}

export async function subscribeBrowser(
  manager: PushManager,
  publicKey: string,
): Promise<PushSubscription> {
  const options = { userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) }
  try {
    return await manager.subscribe(options)
  } catch (error) {
    // A subscription made with an earlier VAPID key blocks a new one.
    const stale = await manager.getSubscription()
    if (!stale) throw error
    await stale.unsubscribe()
    return manager.subscribe(options)
  }
}

/**
 * A signed-out browser holds no subscription: whatever was sent to it would
 * show on a device nobody is signed in on. Asks the server first, so a failed
 * request is never mistaken for a sign-out. The server's row goes when the push
 * service next answers 410.
 */
export async function releasePushSubscriptionIfSignedOut(scope: string): Promise<void> {
  if (!pushSupported()) return
  try {
    const registration = await navigator.serviceWorker.getRegistration(scope)
    const subscription = await registration?.pushManager.getSubscription()
    if (!subscription) return
    // A 401 is a revoked session ("sign out everywhere"). Any other failure
    // says nothing about who is signed in.
    const signedIn = await $fetch<{ user?: unknown }>('/api/_auth/session').then(
      (session) => Boolean(session?.user),
      (error: { statusCode?: number }) => (error?.statusCode === 401 ? false : null),
    )
    if (signedIn === false) await subscription.unsubscribe()
  } catch {
    // Offline, or the browser refused. The next visit tries again.
  }
}
