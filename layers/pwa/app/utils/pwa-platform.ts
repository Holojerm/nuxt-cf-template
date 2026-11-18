// What the browser can tell us about where the app is running. Pure, so the
// workerd tests can call them with made-up hints.

export interface PlatformHints {
  userAgent: string
  platform?: string
  maxTouchPoints?: number
}

/**
 * iPhone, iPod or iPad, in any browser: on iOS they are all WebKit, none fires
 * `beforeinstallprompt`, and the way onto the Home Screen is the Share menu.
 * iPadOS reports itself as a Mac, so a Mac with a touch screen is an iPad.
 */
export function isIosDevice(hints: PlatformHints): boolean {
  if (/iPhone|iPad|iPod/.test(hints.userAgent)) return true
  return hints.platform === 'MacIntel' && (hints.maxTouchPoints ?? 0) > 1
}

/** Chrome's install prompt, which lib.dom does not describe. */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<unknown>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}
