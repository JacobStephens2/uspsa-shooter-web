import { defineConfig } from 'vite';

// base: './' keeps asset URLs relative so the built game works when served
// from any sub-path (GitHub Pages project sites, itch.io, plain static hosts).
export default defineConfig({
  base: './',
  server: { host: true, open: false },
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: false,
  },
});
