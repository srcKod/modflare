import { defineConfig } from 'vitest/config';

// Phase A (unit) runs in the plain Node pool — the tested modules only use
// Web-standard globals. Integration tests (D1 + mocked outbound calls) will
// join later as a second project using @cloudflare/vitest-pool-workers.
//
// Feature manifests import HTML/CSS/JS templates (the admin panel shell via
// core/admin.ts); treat them as inert string assets in the test pool so the
// import chain resolves without a template-aware transform.
export default defineConfig({
  assetsInclude: ['**/*.html', '**/*.css', '**/*.js'],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
