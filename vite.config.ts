import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@domain': path.resolve(__dirname, './src/domain'),
      '@services': path.resolve(__dirname, './src/services'),
      '@repositories': path.resolve(__dirname, './src/repositories'),
      '@interfaces': path.resolve(__dirname, './src/interfaces'),
      '@web': path.resolve(__dirname, './src/web'),
      '@components': path.resolve(__dirname, './src/web/components'),
      '@utils': path.resolve(__dirname, './src/utils'),
    },
  },
  server: {
    port: 11819,
    host: true,
    allowedHosts: ['holocene.delo.sh'],
    proxy: {
      '/api/plane': {
        target: 'https://plane.delo.sh',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/plane/, ''),
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('x-api-key', process.env.VITE_PLANE_33GOD_API_KEY || '');
          });
        },
      },
      '/ws': {
        target: 'http://localhost:8683',
        ws: true,
      },
    },
  },
  preview: {
    host: true,
    allowedHosts: ['holocene.delo.sh'],
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    // setupFiles: './src/web/__tests__/setup.ts',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'src/web/__tests__/',
      ],
    },
  },
});
