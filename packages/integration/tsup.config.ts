import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    hook: 'src/hook.ts',
    mcp: 'src/mcp.ts',
  },
  format: ['esm'],
  outExtension: () => ({ js: '.mjs' }),
  target: 'node20',
  platform: 'node',
  bundle: true,
  splitting: false,
  sourcemap: true,
  // TypeScript 7 declarations are emitted by tsc; tsup's current declaration
  // plugin still embeds an older TypeScript compiler API.
  dts: false,
  clean: true,
  minify: false,
  noExternal: [/@agent-eta\/core/, /@modelcontextprotocol\/sdk/, /zod/],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
