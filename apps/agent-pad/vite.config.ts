import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist' },
  server: {
    // Dev only: recording uploads hit the real proxy so the full flow works under HMR.
    proxy: {
      '/upload': { target: 'https://agent-pad.delo.sh', changeOrigin: true },
    },
  },
})
