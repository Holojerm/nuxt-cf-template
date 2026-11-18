// What the push code on both sides agrees on: the message a notification is
// built from, which hosts count as a push service, and base64url.

/** What `sendPush` sends and the service worker's `push` handler reads. */
export interface PushMessage {
  title: string
  body: string
  /** Where a click on the notification goes. Same-origin; a path is enough. */
  url: string
}

/**
 * The push services browsers hand out endpoints on: Chrome, Edge on Android,
 * Brave and Samsung Internet (FCM), Firefox (Mozilla), Edge on Windows (WNS)
 * and Safari (Apple). A subscription's endpoint is a URL the Worker will POST
 * to, and it comes from the client, so anything else is refused.
 */
export const PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com',
  '.push.services.mozilla.com',
  '.notify.windows.com',
  '.push.apple.com',
] as const

export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return false
  return PUSH_SERVICE_HOSTS.some((host) =>
    host.startsWith('.') ? url.hostname.endsWith(host) : url.hostname === host,
  )
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Throws on anything that is not base64url (padding allowed). */
export function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new Error('Not base64url')
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, ''))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
