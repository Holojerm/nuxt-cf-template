// As much of IndexedDB as the outbox uses, in memory: one database, stores
// keyed by an auto-incrementing `keyPath`, requests that succeed on a later
// microtask and transactions that complete after them. Values are cloned in
// and out, as the real thing does. workerd has no IndexedDB, and the real one
// is exercised by test/e2e/offline.spec.ts.

import type { OutboxIdbFactory } from '../../shared/utils/outbox'

interface Store {
  keyPath: string
  next: number
  rows: Map<number, Record<string, unknown>>
}

export function fakeIndexedDb(): OutboxIdbFactory {
  const stores = new Map<string, Store>()

  const request = <T>(compute: () => T) => {
    const pending = {
      result: undefined as T,
      error: null as unknown,
      onsuccess: null as (() => void) | null,
      onerror: null as (() => void) | null,
    }
    queueMicrotask(() => {
      pending.result = compute()
      pending.onsuccess?.()
    })
    return pending
  }

  const objectStore = (name: string) => {
    const store = stores.get(name)!
    return {
      add: (value: unknown) =>
        request(() => {
          const key = store.next++
          store.rows.set(key, { ...structuredClone(value as object), [store.keyPath]: key })
          return key as unknown
        }),
      put: (value: unknown) =>
        request(() => {
          const row = structuredClone(value as Record<string, unknown>)
          store.rows.set(row[store.keyPath] as number, row)
          return row[store.keyPath]
        }),
      delete: (key: number) => request(() => void store.rows.delete(key)),
      clear: () => request(() => void store.rows.clear()),
      getAll: () =>
        request(
          () =>
            [...store.rows.entries()]
              .sort(([a], [b]) => a - b)
              .map(([, row]) => structuredClone(row)) as never,
        ),
    }
  }

  const database = {
    createObjectStore: (name: string, options: { keyPath: string }) =>
      void stores.set(name, { keyPath: options.keyPath, next: 1, rows: new Map() }),
    transaction: () => {
      const transaction = {
        objectStore,
        error: null as unknown,
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
      }
      // After every request made in the same tick has succeeded.
      setTimeout(() => transaction.oncomplete?.(), 0)
      return transaction
    },
    close: () => {},
  }

  return {
    open: () => {
      const opening = {
        result: database,
        error: null as unknown,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onupgradeneeded: null as (() => void) | null,
      }
      queueMicrotask(() => {
        if (!stores.size) opening.onupgradeneeded?.()
        opening.onsuccess?.()
      })
      return opening
    },
  }
}
