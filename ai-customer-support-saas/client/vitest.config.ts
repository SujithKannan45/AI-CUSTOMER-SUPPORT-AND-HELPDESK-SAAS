import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Component/unit test setup. Deliberately separate from vite.config.ts so the
 * production build never carries test-only configuration.
 *
 * jsdom provides the DOM; `src/test/setup.ts` adds jest-dom matchers,
 * per-test cleanup and the browser APIs jsdom does not implement.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
    clearMocks: true,
  },
});
