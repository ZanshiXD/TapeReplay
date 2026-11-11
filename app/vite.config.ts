import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Shared memory for the optimizer's workers needs a cross-origin isolated page; the desktop app's server and the
// iOS app's server send the same headers.
const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

export default defineConfig({
  base: './', // relative URLs: the apps serve dist/ from their own folders
  plugins: [react()],
  server: { headers: isolation },
  preview: { headers: isolation },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    rollupOptions: { input: { index: 'index.html' } },
  },
});
