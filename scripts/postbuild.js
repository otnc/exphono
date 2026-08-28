/**
 * Drops the JS that the types-only tsdown config still emits, so it is not published
 * as dead weight.
 */

import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const dist = join(import.meta.dirname, '..', 'dist')

for (const name of readdirSync(dist)) {
  if (name.endsWith('.d.ts') || name.endsWith('.d.cts') || name.endsWith('.d.mts')) continue
  const full = join(dist, name)
  if (statSync(full).isDirectory()) continue
  rmSync(full, { force: true })
}

console.log('postbuild: removed type-only build strays from dist/')
