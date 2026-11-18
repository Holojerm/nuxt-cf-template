// Whether the app is on this device, and the two ways of putting it there:
// Chrome's prompt, captured when the browser offers it, and on iOS the Share
// menu, which no page can open.

import type { BeforeInstallPromptEvent } from '../utils/pwa-platform'

// Client only: `trackPwaInstall` is the one writer, and it runs in the browser.
let deferredPrompt: BeforeInstallPromptEvent | null = null

const useInstalled = () => useState('pwa:installed', () => false)
const useCanPrompt = () => useState('pwa:can-prompt', () => false)
const useIos = () => useState('pwa:ios', () => false)

/**
 * Starts listening. Called once by the layer's client plugin, because
 * `beforeinstallprompt` fires soon after load, before any page that would use
 * it has mounted. The browser's own install UI is left alone.
 */
export function trackPwaInstall(): void {
  const installed = useInstalled()
  const canPrompt = useCanPrompt()
  installed.value =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  useIos().value = isIosDevice(navigator)

  window.addEventListener('beforeinstallprompt', (event) => {
    deferredPrompt = event as BeforeInstallPromptEvent
    canPrompt.value = true
  })
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    canPrompt.value = false
    installed.value = true
  })
}

export function usePwaInstall() {
  const installed = useInstalled()
  const canPrompt = useCanPrompt()
  const ios = useIos()

  /** Show the browser's install dialog. Call it from a click; an event prompts once. */
  async function prompt(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    const event = deferredPrompt
    if (!event) return 'unavailable'
    deferredPrompt = null
    canPrompt.value = false
    await event.prompt()
    return (await event.userChoice).outcome
  }

  return {
    /** Running from the home screen (or the dock), not in a browser tab. */
    installed: readonly(installed),
    /** The browser offered an install prompt that `prompt()` can show. */
    canPrompt: readonly(canPrompt),
    /**
     * iOS, not installed yet. There is no prompt: the person taps Share, then
     * Add to Home Screen, and push works only after that.
     */
    needsHomeScreen: computed(() => ios.value && !installed.value),
    prompt,
  }
}
