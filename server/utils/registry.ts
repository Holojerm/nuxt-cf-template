// Keyed registry behind every seam: registering the same key twice (plugin +
// test, or a dev reload) replaces rather than duplicates. Insertion order is
// run order.
//
// A leaf (no imports) so extensions.ts and the seam files can both use it
// without a cycle.

export interface Registry<T> {
  set: (key: string, item: T) => void
  get: (key: string) => T | undefined
  values: () => T[]
  entries: () => [string, T][]
  clear: () => void
}

export function createRegistry<T>(): Registry<T> {
  const items = new Map<string, T>()
  return {
    set: (key, item) => void items.set(key, item),
    get: (key) => items.get(key),
    values: () => [...items.values()],
    entries: () => [...items.entries()],
    clear: () => items.clear(),
  }
}
