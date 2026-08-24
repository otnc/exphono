#!/usr/bin/env node
/**
 * Runs the express test suite against exphono and compares the result with the recorded
 * baseline.
 *
 * The number of failures is the compatibility debt: it is expected to shrink, and the
 * run fails if it grows. Pass `--update` after deliberately changing it.
 *
 * A few of the express tests are timing-sensitive, so the count drifts by one or two
 * between runs of identical code. TOLERANCE absorbs that; a real regression moves the
 * number much further. The counts are also platform-dependent, so a baseline recorded
 * on one OS will not match another exactly.
 *
 *   node test/express-suite/run.js          # check against the baseline
 *   node test/express-suite/run.js --update # record the current numbers
 *   node test/express-suite/run.js --v4     # run the express 4 suite
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { prepare, VERSIONS } from './fetch-suite.js'

const root = resolve(import.meta.dirname, '../..')
const baselinePath = join(import.meta.dirname, 'baseline.json')

/** Slack for flaky, timing-sensitive tests in the express suite. */
const TOLERANCE = 3

const version = process.argv.includes('--v4') ? 4 : 5
const update = process.argv.includes('--update')

if (!existsSync(join(root, 'dist/node/index.cjs'))) {
  console.error('dist/ is missing — run `pnpm build` first (the suite loads the built package).')
  process.exit(1)
}

const suiteDir = prepare(version)

let output = ''
try {
  output = execFileSync(
    process.execPath,
    [
      join(root, 'node_modules/mocha/bin/mocha.js'),
      '--reporter', 'min',
      '--timeout', '5000',
      '--exit',
      `${suiteDir.replace(/\\/g, '/')}/*.js`,
    ],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
  )
} catch (e) {
  // mocha exits non-zero whenever anything failed, which is the normal case here
  output = `${e.stdout ?? ''}${e.stderr ?? ''}`
}

const passing = Number(/(\d+) passing/.exec(output)?.[1] ?? 0)
const failing = Number(/(\d+) failing/.exec(output)?.[1] ?? 0)
const total = passing + failing
const rate = total === 0 ? 0 : (passing / total) * 100

const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : {}
const key = `express${version}`
const previous = baseline[key]

console.log(`express ${VERSIONS[version]} suite: ${passing} passing, ${failing} failing (${rate.toFixed(1)}%)`)

if (update) {
  baseline[key] = { passing, failing, total, recorded: new Date().toISOString().slice(0, 10) }
  writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`)
  console.log('baseline updated')
  process.exit(0)
}

if (!previous) {
  console.error(`no baseline recorded for ${key}; run with --update`)
  process.exit(1)
}

const delta = failing - previous.failing
if (delta > TOLERANCE) {
  console.error(
    `compatibility regressed: ${delta} more failing than the baseline (${previous.failing})`,
  )
  process.exit(1)
}
if (delta < 0) {
  console.log(`${-delta} fewer failing than the baseline (${previous.failing}) — run with --update`)
}
