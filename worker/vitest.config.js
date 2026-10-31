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
  test: { setupFiles: ['./test/setup.js'] },
});
