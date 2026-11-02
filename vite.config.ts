import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    sourcemap: false,
  },
  server: { host: true },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
} as any);
