import { defineConfig } from 'vite';

export default defineConfig({
  base: '/ged-eye/',
  root: '.',
  publicDir: 'public',
  server: {
    fs: {
      allow: ['..']
    }
  },
  build: {
    outDir: 'docs',
    emptyOutDir: true
  },
  test: {
    environment: 'jsdom'
  }
});
