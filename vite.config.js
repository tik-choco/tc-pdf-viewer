import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  // The mist engine normally comes from npm (@tik-choco/mistlib). Point
  // MISTLIB_LOCAL at a local `wasm-pack build` output (mistlib-dev's
  // mistlib-wasm/pkg) in .env to run against an engine you're editing.
  //
  // An alias rather than an npm install so switching leaves package.json and
  // the lockfile untouched — there's nothing to remember to revert. The
  // trade-off: this only redirects Vite (dev and build); this app has no
  // separate typecheck step, so there's nothing else reading from
  // node_modules types to keep in sync.
  //
  // '' as the prefix: loadEnv only exposes VITE_-prefixed keys by default, and
  // MISTLIB_LOCAL is build-time config that must never reach client code.
  const localEngine = loadEnv(mode, process.cwd(), '').MISTLIB_LOCAL;
  const alias = {};
  if (localEngine) {
    alias['@tik-choco/mistlib'] = path.resolve(process.cwd(), localEngine);
    console.log(`vite: using local mist engine at ${alias['@tik-choco/mistlib']}`);
  }

  return {
    base: process.env.VITE_BASE_PATH || '/tc-pdf-viewer/',
    resolve: { alias },
    plugins: [
      preact(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.png', 'apple-touch-icon.png'],
        manifest: {
          name: 'Web PDF Viewer',
          short_name: 'PDF Viewer',
          description: 'AI-powered PDF viewer using mistlib storage',
          theme_color: '#f5f6f8',
          background_color: '#f5f6f8',
          icons: [
            {
              src: 'pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png'
            },
            {
              src: 'pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png'
            },
            {
              src: 'pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any maskable'
            }
          ]
        }
      })
    ],
    optimizeDeps: {
      include: ['pdfjs-dist']
    }
  };
});
