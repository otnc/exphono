/**
 * Downloads the express test suite and rewrites it to run against exphono.
 *
 * The suite is not committed: it is a large third-party tree, and fetching it on demand
 * keeps it pinned to an exact tag. Output goes to a gitignored directory.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const VERSIONS = { 4: '4.22.2', 5: '5.2.1' }

const root = resolve(import.meta.dirname, '../..')
export const vendorRoot = join(root, '.express-suite')

/** `require('..')`, `require('../')`, `require('../.')` and `require('../index')`. */
const EXPRESS_ROOT = new RegExp(String.raw`require\(['"]\.\.(?:/index|/\.|/)?['"]\)`, 'g')

/** A few files read the HTTP verb list out of express's private lib/utils. */
const EXPRESS_UTILS = new RegExp(String.raw`require\(['"]\.\./lib/utils['"]\)`, 'g')

/**
 * Files that exercise express's own internals rather than its public API, so there is
 * nothing for exphono to be compatible with.
 */
const SKIP = new Set(['utils.js'])

const VERBS = [
  'acl', 'bind', 'checkout', 'connect', 'copy', 'delete', 'get', 'head', 'link', 'lock',
  'm-search', 'merge', 'mkactivity', 'mkcalendar', 'mkcol', 'move', 'notify', 'options',
  'patch', 'post', 'propfind', 'proppatch', 'purge', 'put', 'query', 'rebind', 'report',
  'search', 'source', 'subscribe', 'trace', 'unbind', 'unlink', 'unlock', 'unsubscribe',
]

function download(version) {
  const tag = VERSIONS[version]
  const dest = join(vendorRoot, `express-${tag}`)
  if (existsSync(dest)) return dest

  mkdirSync(vendorRoot, { recursive: true })
  const url = `https://github.com/expressjs/express/archive/refs/tags/v${tag}.tar.gz`
  const tarball = `v${tag}.tar.gz`
  // Run inside vendorRoot with relative paths: tar on Windows reads 'D:\...' as a host
  execFileSync('curl', ['-sL', url, '-o', tarball], { cwd: vendorRoot, stdio: 'inherit' })
  execFileSync('tar', ['xzf', tarball], { cwd: vendorRoot, stdio: 'inherit' })
  return dest
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (name.endsWith('.js')) out.push(full)
  }
  return out
}

/** Fetches a version of the suite and returns the directory holding the rewritten tests. */
export function prepare(version) {
  const src = download(version)
  const outDir = join(vendorRoot, `suite-${version}`)
  if (existsSync(outDir)) return outDir

  const testDir = join(src, 'test')
  for (const file of walk(testDir)) {
    const rel = file.slice(testDir.length + 1)
    if (SKIP.has(rel)) continue

    const depth = rel.split(/[\/]/).length - 1
    const utilsPath = depth === 0 ? './_express-utils' : `${'../'.repeat(depth)}_express-utils`

    const target = join(outDir, rel)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(
      target,
      readFileSync(file, 'utf8')
        .replace(EXPRESS_ROOT, "require('exphono')")
        .replace(EXPRESS_UTILS, `require('${utilsPath}')`),
    )
  }

  writeFileSync(
    join(outDir, '_express-utils.js'),
    `// Stand-in for express's private lib/utils; the suite only reads the verb list.\nexports.methods = ${JSON.stringify(VERBS, null, 2)}\n`,
  )

  // The repo is type:module, but the express suite is CommonJS
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }))

  // Fixtures (views, static files) are referenced by relative path
  const fixtures = join(testDir, 'fixtures')
  if (existsSync(fixtures)) execFileSync('cp', ['-r', fixtures, join(outDir, 'fixtures')])

  return outDir
}
