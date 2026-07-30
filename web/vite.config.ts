import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_TARGET = process.env.POOLSTATIS_URL ?? 'http://127.0.0.1:3300';

// Dev proxy: the SPA calls /api and /i on its own origin and vite forwards
// them to the platform server, so there is no CORS to fight in development.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === 'INVALID_ANNOTATION' && warning.id?.includes('@hugeicons/core-free-icons')) return;
        warn(warning);
      },
    },
  },
  server: {
    port: 5273,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/i': { target: API_TARGET, changeOrigin: true },
      '/health': { target: API_TARGET, changeOrigin: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test-setup.ts',
    globals: true,
  },
});
