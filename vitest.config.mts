import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'c3-aws': path.resolve(import.meta.dirname, 'src/index.ts'),
    },
  },
  test: {
    testTimeout: 60_000,
  },
});
