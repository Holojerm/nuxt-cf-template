// Writes that survive having no connection. Call `send()` where the app would
// call `$fetch` for a write: online it sends at once and returns the answer;
// otherwise the write is stored on the device and sent, in order, when the
// connection returns. `waiting` and `failed` are what an app shows: "saved on
// this device, will send when you are back online".
//
// The server route must wrap its write in `idempotent()`
// (server/utils/idempotency.ts): an attempt whose answer was lost is sent again.

import type { OutboxEntry, OutboxMethod } from '../../shared/utils/outbox'
import { PWA_OUTBOX_TAG } from '../../shared/utils/pwa-cache'

export interface OutboxSendOptions {
  /** POST by default. Never DELETE: a DELETE with a body hangs on Workers. */
  method?: OutboxMethod
  /** JSON only. */
  body?: unknown
  /** How long to wait for an answer before storing the write instead. A weak signal hangs, it does not fail. */
  timeout?: number
}

export type OutboxSendResult<T> = { queued: false; data: T } | { queued: true; id: string }

/** How soon to try again after the server asked for a later attempt, with the page still open. */
const RETRY_MS = 30_000
let retryTimer: ReturnType<typeof setTimeout> | undefined
/** A flush was asked for while one was running: something was added behind it. */
let flushAgain = false

export function useOutbox() {
  const { user } = useUserSession()
  const scope = useRuntimeConfig().app.baseURL
  const entries = useState<OutboxEntry[]>('pwa-outbox', () => [])
  const sending = useState('pwa-outbox-sending', () => false)

  /** Stored, and sent as soon as there is a connection. */
  const waiting = computed(() => entries.value.filter((entry) => entry.state === 'waiting'))
  /** The server refused these. They stay until `retry()` or `discard()`. */
  const failed = computed(() => entries.value.filter((entry) => entry.state === 'failed'))

  /** Read this account's entries from the device. Client only. */
  async function refresh(): Promise<void> {
    const owner = user.value?.id
    entries.value = owner ? ((await browserOutbox()?.list(owner)) ?? []) : []
  }

  /** Send what is waiting, oldest first. Safe to call at any time. */
  async function flush(): Promise<void> {
    const owner = user.value?.id
    const box = browserOutbox()
    if (!owner || !box) return
    if (sending.value) {
      flushAgain = true
      return
    }
    sending.value = true
    flushAgain = false
    clearTimeout(retryTimer)
    try {
      const result = await box.replay(owner)
      // Still online and something is left: the server asked for a later try.
      if (result.waiting && navigator.onLine) {
        retryTimer = setTimeout(() => void flush(), RETRY_MS)
      }
    } finally {
      sending.value = false
      await refresh()
    }
    if (flushAgain) await flush()
  }

  /**
   * Make a write. Resolves with the server's answer, or with `queued: true`
   * when it was stored for later. Throws what `$fetch` would when the server
   * answers with an error now: that is the caller's to show, and nothing is
   * stored.
   */
  async function send<T = unknown>(
    url: string,
    options: OutboxSendOptions = {},
  ): Promise<OutboxSendResult<T>> {
    const owner = user.value?.id
    const box = browserOutbox()
    if (!owner) throw new Error('useOutbox: nobody is signed in')
    // `$fetch` adds `app.baseURL` by itself; a replay uses the browser's
    // `fetch`, which does not, so the stored URL carries it.
    const write = {
      id: crypto.randomUUID(),
      owner,
      url: url.startsWith('/') ? `${scope.replace(/\/+$/, '')}${url}` : url,
      method: options.method ?? 'POST',
    }

    // Straight to the server only when nothing is ahead of it in the queue.
    const ahead = box ? (await box.list(owner)).some((entry) => entry.state === 'waiting') : false
    if (!box || (navigator.onLine && !ahead)) {
      try {
        const data = await $fetch<T>(url, {
          method: write.method,
          body: options.body as Record<string, unknown> | undefined,
          headers: box?.headers(write),
          timeout: options.timeout ?? 10_000,
        })
        return { queued: false, data }
      } catch (error) {
        // An answer, even a refusal, is the caller's. No answer at all (no
        // connection, a timeout) may still have reached the server, which is
        // why the stored write keeps this attempt's key.
        if (!box || (error as { response?: unknown }).response) throw error
      }
    }

    await box.add({ ...write, body: options.body })
    await refresh()
    announceOutboxChange()
    void requestSync()
    if (navigator.onLine) void flush()
    return { queued: true, id: write.id }
  }

  /** Background Sync, where the browser has it: the worker sends even if the app is closed by then. */
  async function requestSync(): Promise<void> {
    try {
      const registration = await navigator.serviceWorker?.getRegistration(scope)
      const sync = (registration as { sync?: { register(tag: string): Promise<void> } } | undefined)
        ?.sync
      await sync?.register(PWA_OUTBOX_TAG)
    } catch {
      // Not supported or not allowed. The page sends on `online` and on load.
    }
  }

  /** Put a failed write back in line. */
  async function retry(entry: OutboxEntry): Promise<void> {
    await browserOutbox()?.retry(entry.seq)
    announceOutboxChange()
    await flush()
  }

  /** Give up on a write. The only way one leaves without being sent. */
  async function discard(entry: OutboxEntry): Promise<void> {
    await browserOutbox()?.discard(entry.seq)
    announceOutboxChange()
    await refresh()
  }

  return {
    waiting,
    failed,
    sending: readonly(sending),
    send,
    flush,
    refresh,
    retry,
    discard,
  }
}
