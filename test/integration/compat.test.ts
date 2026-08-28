/**
 * The `exphono/v4` and `exphono/v5` subpaths.
 *
 * Each pins its own Express major. They must not share mutable state, so importing both
 * in one program keeps them independent.
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import v4 from '../../src/v4.js'
import v5 from '../../src/v5.js'
import base from '../../src/index.js'

const distReady = existsSync(join(resolve(import.meta.dirname, '../..'), 'dist/node/v4.mjs'))

type Factory = typeof base

async function query(express: Factory, url: string): Promise<unknown> {
  const app = express()
  app.get('/q', (req, res) => {
    res.json(req.query)
  })
  const res = await app.fetch(new Request(`http://localhost${url}`))
  return res.json()
}

describe('compat subpaths', () => {
  it('v4 uses the extended query parser', async () => {
    expect(await query(v4, '/q?a[b]=1')).toEqual({ a: { b: '1' } })
  })

  it('v5 uses the simple query parser', async () => {
    expect(await query(v5, '/q?a[b]=1')).toEqual({ 'a[b]': '1' })
  })

  it('the two factories are independent', () => {
    expect(v4).not.toBe(v5)
    expect(v4().get('query parser')).toBe('extended')
    expect(v5().get('query parser')).toBe('simple')
  })

  it('changing the default on the main entry does not affect the pinned ones', () => {
    const before = v4().get('query parser')
    base.configure({ compat: '4' })
    try {
      expect(v5().get('query parser')).toBe('simple')
      expect(v4().get('query parser')).toBe(before)
    } finally {
      base.configure({ compat: '5' })
    }
  })

  it('each subpath carries the full express surface', () => {
    for (const factory of [v4, v5]) {
      expect(typeof factory).toBe('function')
      expect(typeof factory.Router).toBe('function')
      expect(typeof factory.json).toBe('function')
      expect(typeof factory.static).toBe('function')
    }
  })

  it.runIf(distReady)('resolves through the exports map', async () => {
    const { execFileSync } = await import('node:child_process')
    const out = execFileSync(
      process.execPath,
      ['-e', "console.log(require.resolve('exphono/v4').replace(/\\\\/g, '/'))"],
      { encoding: 'utf8', cwd: resolve(import.meta.dirname, '../..') },
    )
    expect(out.trim()).toContain('dist/node/v4.cjs')
  })
})

describe('express 4 only APIs', () => {
  it('req.param reads params, body then query under v4', async () => {
    const app = v4()
    app.get('/p/:id', (req, res) => {
      res.json({ id: req.param('id'), missing: req.param('nope', 'fallback') })
    })
    const res = await app.fetch(new Request('http://localhost/p/42'))
    expect(await res.json()).toEqual({ id: '42', missing: 'fallback' })
  })

  it('app.del registers a DELETE route', async () => {
    const app = v4()
    app.del('/gone', (_req, res) => {
      res.send('deleted')
    })
    const res = await app.fetch(new Request('http://localhost/gone', { method: 'DELETE' }))
    expect(await res.text()).toBe('deleted')
  })
})
