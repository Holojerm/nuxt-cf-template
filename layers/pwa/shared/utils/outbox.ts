// The outbox: writes made without a connection, kept in IndexedDB and sent in
// the order they were made.
//
// `outbox` runs in two places from one source: the page imports it
// (app/composables/useOutbox.ts) and GET /sw.js sends its source to the service
// worker, which replays on a Background Sync. So, like `serviceWorker`, it
// **must read nothing outside its own body**: no imports, no module-level
// constants, no helpers. Everything it needs arrives in `env`.
//
// IndexedDB is typed here by hand, as far as it is used: this file is compiled
// for the Worker too, which has no DOM types.

interface IdbRequest<T> {
  result: T
  error: unknown
  onsuccess: (() => void) | null
  onerror: (() => void) | null
}

interface IdbStore {
  add(value: unknown): IdbRequest<unknown>
  put(value: unknown): IdbRequest<unknown>
  delete(key: number): IdbRequest<undefined>
  clear(): IdbRequest<undefined>
  getAll(): IdbRequest<OutboxEntry[]>
}

interface IdbTransaction {
  objectStore(name: string): IdbStore
  error: unknown
  oncomplete: (() => void) | null
  onerror: (() => void) | null
  onabort: (() => void) | null
}

interface IdbDatabase {
  createObjectStore(name: string, options: { keyPath: string; autoIncrement: boolean }): unknown
  transaction(name: string, mode: 'readonly' | 'readwrite'): IdbTransaction
  close(): void
}

export interface OutboxIdbFactory {
  open(
    name: string,
    version: number,
  ): IdbRequest<IdbDatabase> & {
    onupgradeneeded: (() => void) | null
  }
}

export interface OutboxResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  text(): Promise<string>
}

export interface OutboxEnv {
  indexedDB: OutboxIdbFactory
  fetch(
    url: string,
    init: { method: string; headers: Record<string, string>; body: string; signal?: unknown },
  ): Promise<OutboxResponse>
  /** Web Locks, where the browser has them: one replay at a time across tabs and the worker. */
  locks?: { request<T>(name: string, work: () => Promise<T>): Promise<T> }
  /** Called after a replay that sent or failed something, to tell other tabs. */
  changed?: () => void
  now?: () => number
}

/** A DELETE with a body hangs on Workers, so a queued write is never one. */
export type OutboxMethod = 'POST' | 'PUT' | 'PATCH'

export interface OutboxWrite {
  /** Doubles as the idempotency key, so the server answers a replay without writing twice. */
  id: string
  /** The account that made the write. It is never sent as anyone else. */
  owner: string
  url: string
  method: OutboxMethod
  /** JSON only: no files, no FormData. */
  body?: unknown
}

export interface OutboxEntry extends OutboxWrite {
  /** Order of arrival. */
  seq: number
  createdAt: number
  /** Times the server answered and the write still could not be sent. */
  attempts: number
  /** `failed` = the server said no. Kept until the app retries or discards it. */
  state: 'waiting' | 'failed'
  error?: { status: number; message: string }
}

export interface OutboxReplay {
  sent: number
  failed: number
  /** Still to send: no connection, or the server asked to try later. */
  waiting: number
}

export function outbox(env: OutboxEnv) {
  const STORE = 'writes'
  // A write the server keeps answering 5xx to stops holding up the ones behind it.
  const MAX_ATTEMPTS = 5
  // A weak signal hangs instead of failing, and a replay that never ends
  // blocks every later one.
  const TIMEOUT_MS = 20_000

  const open = () =>
    new Promise<IdbDatabase>((resolve, reject) => {
      const request = env.indexedDB.open('pwa-outbox', 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { keyPath: 'seq', autoIncrement: true })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })

  /** One transaction. Resolves with the request's result once it has committed. */
  const transact = async <T>(
    mode: 'readonly' | 'readwrite',
    work: (store: IdbStore) => IdbRequest<T>,
  ): Promise<T> => {
    const db = await open()
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode)
        const request = work(transaction.objectStore(STORE))
        transaction.oncomplete = () => resolve(request.result)
        transaction.onerror = () => reject(transaction.error ?? request.error)
        transaction.onabort = () => reject(transaction.error ?? request.error)
      })
    } finally {
      db.close()
    }
  }

  /** What every attempt carries, the first one included: a replay must repeat the same key. */
  const headers = (write: { id: string; owner: string }): Record<string, string> => ({
    'Content-Type': 'application/json',
    'Idempotency-Key': write.id,
    'X-Outbox-Owner': write.owner,
  })

  /** Everything stored, oldest first. With `owner`, only that account's. */
  const list = async (owner?: string): Promise<OutboxEntry[]> => {
    const entries = await transact('readonly', (store) => store.getAll())
    return owner === undefined ? entries : entries.filter((entry) => entry.owner === owner)
  }

  const add = async (write: OutboxWrite): Promise<void> => {
    const now = env.now ? env.now() : Date.now()
    await transact('readwrite', (store) =>
      store.add({ ...write, createdAt: now, attempts: 0, state: 'waiting' }),
    )
  }

  const discard = (seq: number) => transact('readwrite', (store) => store.delete(seq))

  /** Put a failed write back in line, at its original place. */
  const retry = async (seq: number): Promise<void> => {
    const entry = (await list()).find((candidate) => candidate.seq === seq)
    if (!entry) return
    await transact('readwrite', (store) =>
      store.put({ ...entry, attempts: 0, state: 'waiting', error: undefined }),
    )
  }

  const clear = () => transact('readwrite', (store) => store.clear())

  /** The server's own sentence for a refusal. Never a 5xx's: that is not for the person. */
  const reason = async (response: OutboxResponse): Promise<string> => {
    if (response.status >= 500) return ''
    try {
      const body: unknown = JSON.parse(await response.text())
      const fields = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
      const text = fields.message ?? fields.statusMessage
      return typeof text === 'string' ? text.slice(0, 200) : ''
    } catch {
      return ''
    }
  }

  const run = async (owner?: string): Promise<OutboxReplay> => {
    const result: OutboxReplay = { sent: 0, failed: 0, waiting: 0 }
    const entries = await list()
    for (const [index, entry] of entries.entries()) {
      // Another account's write, left by a tab that outlived its sign-out.
      if (owner !== undefined && entry.owner !== owner) {
        await discard(entry.seq)
        continue
      }
      if (entry.state === 'failed') continue

      const stop = () => {
        result.waiting = entries
          .slice(index)
          .filter(
            (later) => later.state === 'waiting' && (owner === undefined || later.owner === owner),
          ).length
      }
      let response: OutboxResponse
      try {
        response = await env.fetch(entry.url, {
          method: entry.method,
          headers: headers(entry),
          body: JSON.stringify(entry.body ?? null),
          signal: typeof AbortSignal === 'undefined' ? undefined : AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch {
        // No connection. Everything behind it waits too, to keep the order.
        stop()
        break
      }
      if (response.ok) {
        await discard(entry.seq)
        result.sent += 1
        continue
      }
      // 401: the session ended, and the page decides what happens to the queue.
      if (response.status === 401) {
        stop()
        break
      }
      const error = { status: response.status, message: await reason(response) }
      const later =
        response.status >= 500 ||
        response.status === 408 ||
        response.status === 429 ||
        response.headers.get('Retry-After') !== null
      if (later && entry.attempts + 1 < MAX_ATTEMPTS) {
        await transact('readwrite', (store) =>
          store.put({ ...entry, attempts: entry.attempts + 1, error }),
        )
        stop()
        break
      }
      // The server said no. Kept and shown, never dropped; the next write goes on.
      await transact('readwrite', (store) =>
        store.put({ ...entry, attempts: entry.attempts + 1, state: 'failed', error }),
      )
      result.failed += 1
    }
    if (result.sent || result.failed) env.changed?.()
    return result
  }

  /**
   * Send what is waiting, oldest first. With `owner`, anything stored under
   * another account is deleted unsent. The worker passes none: it cannot know
   * who is signed in, so the server checks the owner each write names.
   */
  const replay = (owner?: string): Promise<OutboxReplay> =>
    env.locks ? env.locks.request('pwa-outbox', () => run(owner)) : run(owner)

  return { headers, list, add, discard, retry, clear, replay }
}

export type Outbox = ReturnType<typeof outbox>
