import { defineConfig } from 'vitest/config';

// One database is stood up per test file. Real-Postgres runs share a single
// server, so files never run in parallel — the engines behave identically.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
