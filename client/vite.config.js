import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Vaccination Registry',
        short_name: 'VaxRegistry',
        description: 'Offline-first patient registry and vaccination scheduling for rural clinics',
        theme_color: '#0f766e',
        background_color: '#f6f7f5',
        display: 'standalone',
        start_url: '/',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
      workbox: {
        // The app shell is cached so the app opens without internet.
        // API calls are never cached: offline data lives in IndexedDB.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,svg}'],
      },
    }),
  ],
  server: {
    // Bound to 127.0.0.1 so http://localhost:5173 and http://127.0.0.1:5173 can be
    // opened side by side as two separate "clinic devices" (separate storage).
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:4000' },
  },
});
