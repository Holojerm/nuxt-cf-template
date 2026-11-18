// Notifications on this device: the browser's permission, whether this
// browser's subscription is stored for the signed-in account, and the two
// actions that change it. Nothing here asks for permission by itself:
// `subscribe()` does, and only a person's click should call it.

export function usePushSubscription() {
  const config = useRuntimeConfig()
  const scope = config.app.baseURL
  const publicKey = config.public.pwa.vapidPublicKey

  /** The app has VAPID keys. False = there is nothing to offer. */
  const configured = Boolean(config.public.pwa.enabled && publicKey)
  /** This browser can do it. False on iOS until the app is on the Home Screen. */
  const supported = ref(false)
  const permission = ref<NotificationPermission>('default')
  const subscribed = ref(false)
  const pending = ref(false)

  /** Read the current state. Client only; call it once mounted. */
  async function refresh(): Promise<void> {
    supported.value = configured && pushSupported()
    if (!supported.value) return
    permission.value = Notification.permission
    const registration = await navigator.serviceWorker.getRegistration(scope)
    const subscription = await registration?.pushManager.getSubscription()
    if (!subscription || permission.value !== 'granted') {
      subscribed.value = false
      return
    }
    // The browser keeps a subscription across sign-ins, so only the server
    // knows whether this one is this account's.
    const status = await $fetch<{ subscribed: boolean }>('/api/pwa/push/status', {
      method: 'POST',
      body: { endpoint: subscription.endpoint },
    })
    subscribed.value = status.subscribed
  }

  /** False when the person said no to the browser's question. Throws when it could not be done. */
  async function subscribe(): Promise<boolean> {
    pending.value = true
    try {
      permission.value = await Notification.requestPermission()
      if (permission.value !== 'granted') return false
      const registration = await activePwaRegistration(scope)
      if (!registration) throw new Error('The service worker is not running')
      const subscription = await subscribeBrowser(registration.pushManager, publicKey)
      try {
        await $fetch('/api/pwa/push/subscribe', { method: 'POST', body: subscription.toJSON() })
      } catch (error) {
        // Not stored, so nothing would ever be sent to it.
        await subscription.unsubscribe()
        throw error
      }
      subscribed.value = true
      return true
    } finally {
      pending.value = false
    }
  }

  async function unsubscribe(): Promise<void> {
    pending.value = true
    try {
      const registration = await navigator.serviceWorker.getRegistration(scope)
      const subscription = await registration?.pushManager.getSubscription()
      if (subscription) {
        // The server first: if it fails, the switch stays on and says so.
        await $fetch('/api/pwa/push/unsubscribe', {
          method: 'POST',
          body: { endpoint: subscription.endpoint },
        })
        await subscription.unsubscribe()
      }
      subscribed.value = false
    } finally {
      pending.value = false
    }
  }

  return {
    configured,
    supported: readonly(supported),
    permission: readonly(permission),
    subscribed: readonly(subscribed),
    pending: readonly(pending),
    refresh,
    subscribe,
    unsubscribe,
  }
}
