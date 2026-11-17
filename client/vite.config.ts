import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('../shared/src', import.meta.url)) },
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: { outDir: 'dist', assetsDir: 'static', target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 900 },
});
