import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  clean: true,
  sourcemap: false,
  splitting: false,
  treeshake: true,
  target: 'node18',
  // Same reasoning as @raeven-co/sether: ASCII-only output, so supply-chain
  // scanners never see raw non-ASCII (the • masks become •).
  esbuildOptions(options) {
    options.charset = 'ascii';
  },
});
