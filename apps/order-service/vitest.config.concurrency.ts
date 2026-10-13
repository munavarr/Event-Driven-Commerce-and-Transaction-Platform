import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.concurrency-spec.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
