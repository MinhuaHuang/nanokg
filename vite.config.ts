import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(rootDir, 'web') } },
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
