import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.mjs'],
    environment: 'node',
    // Network-dependent behavior is always tested with fixtures/stubs; keep
    // the suite fast and hermetic.
    testTimeout: 15000,
  },
});
