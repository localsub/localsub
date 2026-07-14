import "@testing-library/jest-dom/vitest";

// Mock crypto.randomUUID for tests
let uuidCounter = 0;
if (!globalThis.crypto?.randomUUID) {
  Object.defineProperty(globalThis, "crypto", {
    value: {
      randomUUID: () => `test-uuid-${++uuidCounter}`,
    },
  });
}
