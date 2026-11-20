// What to call a passkey on the device in hand. "Passkey" is a word most people
// have not met; the thing that unlocks their phone is. A guess from the user
// agent, used for wording only: nothing is decided on it.

export interface PasskeyDevice {
  /** Fits "Continue with …" and "Use … next time". */
  method: string
  /** The name the new passkey is saved under, shown on the security page. */
  label: string
}

/** Before the page has mounted, and wherever the guess finds nothing. */
export const UNKNOWN_PASSKEY_DEVICE: PasskeyDevice = { method: 'a passkey', label: 'This device' }
const OTHER = UNKNOWN_PASSKEY_DEVICE

export function passkeyDevice(
  nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> | undefined,
): PasskeyDevice {
  const agent = nav?.userAgent ?? ''
  // iPadOS asks for desktop pages and says "Macintosh"; only the touch screen gives it away.
  if (/iPhone/.test(agent)) return { method: 'Face ID or Touch ID', label: 'iPhone' }
  if (/iPad/.test(agent) || (/Macintosh/.test(agent) && (nav?.maxTouchPoints ?? 0) > 1)) {
    return { method: 'Face ID or Touch ID', label: 'iPad' }
  }
  if (/Macintosh/.test(agent)) return { method: 'Touch ID', label: 'Mac' }
  if (/Android/.test(agent)) return { method: 'your screen lock', label: 'Android phone' }
  if (/Windows/.test(agent)) return { method: 'Windows Hello', label: 'Windows computer' }
  return OTHER
}
