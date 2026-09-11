import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['cli/index.ts'],
  format: ['esm'],
  tsconfig: 'tsconfig.node.json',
  dts: true,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
});
