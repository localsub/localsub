import "@testing-library/jest-dom/vitest";

// Node 25+ ships an experimental Web Storage global. Without --localstorage-file
// its `localStorage` is undefined, and because it already exists on globalThis
// Vitest does not overwrite it with jsdom's — so every module that reads
// localStorage at import time (src/i18n) crashes. Put jsdom's storage back.
// No-op on Node 20/22 (CI), where jsdom's storage is already the global one.
const jsdomWindow = (globalThis as { jsdom?: { window: Window } }).jsdom?.window;
if (jsdomWindow) {
  for (const key of ["localStorage", "sessionStorage"] as const) {
    if (globalThis[key] !== jsdomWindow[key]) {
      Object.defineProperty(globalThis, key, {
        configurable: true,
        get: () => jsdomWindow[key],
      });
    }
  }
}

// Mock crypto.randomUUID for tests
let uuidCounter = 0;
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, "crypto", {
    value: {
      randomUUID: () => `test-uuid-${++uuidCounter}`,
    },
  });
}
