import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { VitePWA } from 'vite-plugin-pwa';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) }, // shown in the menu footer
  plugins: [
    VitePWA({
      registerType: 'prompt', // the app decides when to reload (see ui/updateToast.js)
      injectRegister: false, // registered from main.js via virtual:pwa-register
      manifest: false, // hand-written public/manifest.webmanifest, linked from index.html
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
        navigateFallback: 'index.html',
        // The static policy page is its own document, not an app route.
        navigateFallbackDenylist: [/^\/privacy\.html$/, /^\/api\//],
      },
    }),
  ],
  test: { environment: 'node', setupFiles: ['tests/setup.js'] },
});
