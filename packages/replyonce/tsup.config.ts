import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      index: 'src/index.ts',
      postgres: 'src/stores/postgres.ts',
      redis: 'src/stores/redis.ts',
      adapters: 'src/adapters/index.ts',
    },
    format: ['esm', 'cjs'],
    target: 'node18',
    dts: true,
    clean: true,
    sourcemap: true,
    splitting: false,
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
    sourcemap: false,
    splitting: false,
  },
]);
