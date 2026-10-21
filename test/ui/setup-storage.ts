// Node 24 + Vitest 4's worker enables Web Storage with an invalid `--localstorage-file`
// path, leaving a broken global `localStorage` object with no Storage methods
// (`localStorage.clear is not a function`) that shadows jsdom's own implementation.
// jsdom itself is healthy; only the global binding is broken. Install a spec-compliant
// in-memory Storage when the ambient one is unusable. Feature-detected: no-ops if the
// environment ever provides a working Storage.
class MemoryStorage implements Storage {
  #map = new Map<string, string>();
  get length() {
    return this.#map.size;
  }
  clear() {
    this.#map.clear();
  }
  getItem(key: string) {
    return this.#map.has(key) ? (this.#map.get(key) as string) : null;
  }
  key(index: number) {
    return Array.from(this.#map.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.#map.delete(key);
  }
  setItem(key: string, value: string) {
    this.#map.set(key, String(value));
  }
}

function ensure(name: "localStorage" | "sessionStorage") {
  const current = (globalThis as Record<string, unknown>)[name] as Storage | undefined;
  if (typeof current?.clear === "function" && typeof current?.setItem === "function") return;
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, name, { value: storage, configurable: true, writable: true });
  if (typeof window !== "undefined") {
    Object.defineProperty(window, name, { value: storage, configurable: true, writable: true });
  }
}

ensure("localStorage");
ensure("sessionStorage");
