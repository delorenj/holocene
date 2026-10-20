import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist' },
  server: {
    // Dev only: recording uploads and the agent roster hit production so the full flow works under HMR.
    proxy: {
      '/upload': { target: 'https://agent-pad.delo.sh', changeOrigin: true },
      // Referer must not leak through: Cloudflare hotlink protection 403s avatar images that carry a
      // foreign Referer, and every tile would fall back to a letter in dev while prod (same origin) is fine.
      '/roster': {
        target: 'https://agent-pad.delo.sh', changeOrigin: true,
        headers: { referer: '', origin: '' },
      },
    },
  },
})
