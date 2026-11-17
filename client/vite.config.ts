import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('../shared/src', import.meta.url)) },
  },
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true },
  build: {
    outDir: 'dist',
    assetsDir: 'static',
    target: 'es2022',
    sourcemap: false,
    // The three.js chunk is ~690 kB minified (172 kB gzip) and cannot be split further in a useful way.
    chunkSizeWarningLimit: 750,
    rollupOptions: {
      output: {
        // three.js rarely changes: keep it in its own long-cached chunk, separate from game code.
        manualChunks: (id: string) => (id.includes('node_modules/three/') ? 'three' : undefined),
      },
    },
  },
});
