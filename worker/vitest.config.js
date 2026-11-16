import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/index.js',
      miniflare: {
        compatibilityDate: '2026-08-01',
        d1Databases: ['DB'],
        r2Buckets: ['PHOTOS'],
      },
    }),
  ],
  // testTimeout: the D1-heavy tests (10 000-record caps) can take over 5 s on a busy machine (CI).
  test: { setupFiles: ['./test/setup.js'], testTimeout: 30000 },
});
