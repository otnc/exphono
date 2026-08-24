import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'

const src = (p: string) => fileURLToPath(new URL(`./src/${p}`, import.meta.url))

/**
 * Swaps the `app.listen()` implementation for the edge build.
 *
 * `serve.ts` dynamically imports `@hono/node-server`, and bundlers follow dynamic
 * imports, so leaving it in drags `node:http` into a Workers bundle.
 */
const edgeAlias = { [src('runtime/serve.js')]: src('runtime/serve.edge.ts') }

/**
 * Four outputs:
 *
 *   dist/node/index.mjs   ESM for Node and Bun
 *   dist/node/index.cjs   CJS for Node, shaped as `module.exports = express`
 *   dist/edge/index.mjs   ESM for Workers and Deno
 *   dist/index.d.*        types, shared across runtimes
 *
 * CJS gets its own entry because rolldown otherwise emits `exports.default = ...`, which
 * breaks `require('exphono')()`; `exports: 'default'` needs a single default export.
 */
export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    outDir: 'dist/node',
    platform: 'node',
    target: 'node20',
    dts: false,
    clean: true,
    outputOptions: { entryFileNames: 'index.mjs' },
  },
  {
    entry: ['src/index.cjs-entry.ts'],
    format: ['cjs'],
    outDir: 'dist/node',
    platform: 'node',
    target: 'node20',
    dts: false,
    clean: false,
    outputOptions: { exports: 'default', entryFileNames: 'index.cjs' },
  },
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    outDir: 'dist/edge',
    platform: 'neutral',
    target: 'es2022',
    dts: false,
    clean: false,
    alias: edgeAlias,
    outputOptions: { entryFileNames: 'index.mjs' },
  },
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    outDir: 'dist',
    platform: 'neutral',
    target: 'es2022',
    dts: { emitDtsOnly: true },
    clean: false,
  },
])
