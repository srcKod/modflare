import { defineConfig } from 'vitest/config';

// Phase A (unit) runs in the plain Node pool — the tested modules only use
// Web-standard globals. Integration tests (D1 + mocked outbound calls) will
// join later as a second project using @cloudflare/vitest-pool-workers.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
