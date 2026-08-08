import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * Vitest needs the `@/*` alias spelled out because it does not read `tsconfig.json` paths.
 *
 * Without this, `tsc` and `next build` resolve `@/lib/...` while the tests do not, so the
 * suite silently forces `../../../lib/...` everywhere and the two halves of the codebase
 * drift into different import styles.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // Node, not jsdom: everything under test here is server-side — checks, hashing, signing
    // and a route handler. A DOM would only slow the run down.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
