/**
 * Drops the JS that the types-only tsdown config still emits, so it is not published
 * as dead weight.
 */

import { rmSync } from 'node:fs'
import { join } from 'node:path'

const dist = join(import.meta.dirname, '..', 'dist')

for (const stray of ['index.cjs', 'index.js', 'index.mjs']) {
  rmSync(join(dist, stray), { force: true })
}

console.log('postbuild: removed type-only build strays from dist/')
