/**
 * Every import / require form an Express user might write.
 *
 * Loads the build output rather than the source, since the CJS `module.exports = express`
 * shape depends on the build config, and resolves by package name so the `exports` map
 * is exercised too (the repo is linked into its own devDependencies).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const distReady = existsSync(join(root, 'dist/node/index.cjs'))

// Kept inside the repo so the self-link resolves
const scratch = join(root, '.consumption-tmp')

function runScript(filename: string, source: string): string {
  mkdirSync(scratch, { recursive: true })
  const file = join(scratch, filename)
  writeFileSync(file, source)
  return execFileSync(process.execPath, [file], { encoding: 'utf8', cwd: root }).trim()
}

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe.skipIf(!distReady)('ESM consumption', () => {
  it('default import is callable', () => {
    expect(
      runScript(
        'esm.mjs',
        `import express from 'exphono'
const app = express()
console.log(typeof express, typeof app, app.length)`,
      ),
    ).toBe('function function 3')
  })

  it('named imports resolve', () => {
    expect(
      runScript(
        'named.mjs',
        `import { Router, json, urlencoded, Route, request, response } from 'exphono'
console.log(
  typeof Router, typeof json, typeof urlencoded,
  typeof Route, typeof request, typeof response,
)`,
      ),
    ).toBe('function function function function object object')
  })

  it('default and named can be mixed', () => {
    expect(
      runScript(
        'mixed.mjs',
        `import express, { Router } from 'exphono'
console.log(typeof express(), typeof Router())`,
      ),
    ).toBe('function function')
  })

  it('aliased named import works', () => {
    expect(
      runScript(
        'alias.mjs',
        `import { Router as R, static as serveStatic } from 'exphono'
console.log(typeof R, typeof serveStatic)`,
      ),
    ).toBe('function function')
  })

  it('exposes the helpers as properties of the default export', () => {
    expect(
      runScript(
        'props.mjs',
        `import express from 'exphono'
console.log(typeof express.Router, typeof express.json, typeof express.static)`,
      ),
    ).toBe('function function function')
  })

  it('namespace import gives default but is not itself callable', () => {
    expect(
      runScript(
        'ns.mjs',
        `import * as ns from 'exphono'
console.log(typeof ns, typeof ns.default, typeof ns.Router)`,
      ),
    ).toBe('object function function')
  })

  it('dynamic import works', () => {
    expect(
      runScript(
        'dyn.mjs',
        `const m = await import('exphono')
console.log(typeof m.default, typeof m.default())`,
      ),
    ).toBe('function function')
  })

  it('side-effect-only import does nothing observable', () => {
    expect(
      runScript(
        'side.mjs',
        `import 'exphono'
console.log('loaded')`,
      ),
    ).toBe('loaded')
  })

  it('serves a request end to end', () => {
    expect(
      runScript(
        'serve.mjs',
        `import express from 'exphono'
const app = express()
app.use(express.json())
app.get('/hi/:name', (req, res) => res.json({ hi: req.params.name }))
const res = await app.fetch(new Request('http://localhost/hi/otoneko'))
console.log(res.status, await res.text())`,
      ),
    ).toBe('200 {"hi":"otoneko"}')
  })
})

describe.skipIf(!distReady)('CJS consumption', () => {
  it('require() returns the express function itself, not a namespace', () => {
    expect(
      runScript(
        'req.cjs',
        `const express = require('exphono')
console.log(typeof express, 'default' in express)`,
      ),
    ).toBe('function false')
  })

  it('require()() is callable', () => {
    expect(
      runScript(
        'call.cjs',
        `const express = require('exphono')
console.log(typeof express(), express().length)`,
      ),
    ).toBe('function 3')
  })

  it('destructuring named helpers works', () => {
    expect(
      runScript(
        'destructure.cjs',
        `const { Router, json, urlencoded, Route } = require('exphono')
console.log(typeof Router, typeof json, typeof urlencoded, typeof Route)`,
      ),
    ).toBe('function function function function')
  })

  it('destructures the reserved-word export via renaming', () => {
    expect(
      runScript(
        'static.cjs',
        `const { static: serveStatic } = require('exphono')
console.log(typeof serveStatic)`,
      ),
    ).toBe('function')
  })

  it('property access works', () => {
    expect(runScript('prop.cjs', `console.log(typeof require('exphono').Router())`)).toBe('function')
  })

  it('resolves through the exports map to the CJS build', () => {
    expect(
      runScript('resolve.cjs', `console.log(require.resolve('exphono').replace(/\\\\/g, '/'))`),
    ).toContain('dist/node/index.cjs')
  })

  it('serves a request end to end', () => {
    expect(
      runScript(
        'serve.cjs',
        `const express = require('exphono')
const app = express()
app.get('/', (req, res) => res.send('cjs ok'))
app.fetch(new Request('http://localhost/')).then(async (r) => {
  console.log(r.status, await r.text())
})`,
      ),
    ).toBe('200 cjs ok')
  })
})
