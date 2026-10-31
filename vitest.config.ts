import { defineConfig } from "vitest/config";

// PGlite boots a WASM Postgres per testDb(); allow for slow or loaded machines.
export default defineConfig({ test: { include: ["src/**/*.test.ts"], testTimeout: 120_000, hookTimeout: 120_000 } });
