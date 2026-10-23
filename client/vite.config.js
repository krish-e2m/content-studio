import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// SPA frontend. Client data comes from the Node/Express API (server/).
export default defineConfig({
  plugins: [react()],
  // Load .env from the repo root (one level up) so a single root .env serves
  // both the server and the client. Only VITE_* vars are exposed to the
  // browser bundle - server secrets in the same file stay private.
  envDir: '..',
  // host: true exposes the server on your LAN so other devices (phone, etc.)
  // can open the printed Network URL.
  server: {
    port: 5173,
    open: true,
    host: true,
    // Proxy API calls to the backend so the browser stays same-origin (no CORS).
    proxy: {
      // TikTok Apify runs can take several minutes; the default proxy timeout
      // would abort the refresh and make the channel look like it never fetched.
      '/api': { target: 'http://localhost:4000', changeOrigin: true, timeout: 600000, proxyTimeout: 600000 },
    },
  },
  preview: { port: 4173, host: true },
})
