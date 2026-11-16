import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // CI runners (macOS especially) are several times slower than a laptop;
    // the scan-heavy tests take 2-3 s locally. Speed regressions are caught
    // by explicit duration assertions, not by this cap.
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
    },
  },
});
