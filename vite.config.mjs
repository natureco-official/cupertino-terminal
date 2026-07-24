import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve(process.cwd(), 'src'),
  base: './',
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    outDir: resolve(process.cwd(), 'dist-tauri'),
    emptyOutDir: true,
    target: ['es2021', 'chrome105', 'safari13'],
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@xterm/')) return 'xterm-core';
          if (id.includes('@tauri-apps/')) return 'tauri-api';
          return 'vendor';
        },
      },
    },
  },
});
