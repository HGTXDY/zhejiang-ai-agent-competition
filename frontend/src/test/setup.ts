import { beforeEach } from 'vitest'

// jsdom may not expose `localStorage` as a global on an opaque origin, so install
// a minimal in-memory fallback so persistence code and tests behave like a browser.
if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map<string, string>()
  const memoryStorage: Storage = {
    get length() { return store.size },
    clear: () => { store.clear() },
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => { store.delete(key) },
    setItem: (key: string, value: string) => { store.set(key, String(value)) },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true, writable: true })
}

beforeEach(() => {
  try { localStorage.clear() } catch { /* storage unavailable in this environment */ }
})
