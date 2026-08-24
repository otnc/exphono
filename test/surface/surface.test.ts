/**
 * Compares the real express objects against exphono's at runtime to catch any API
 * Express has and exphono does not.
 *
 * Only the members Express itself defines are required. The rest of
 * `http.IncomingMessage.prototype` behind `express.request` is out of scope: exphono
 * implements a declared subset of the Node surface rather than reimplementing streams.
 * That subset is asserted separately below.
 */

import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import exphono from '../../src/index.js'
import { HTTP_METHODS, surfaceApisFor, type ApiTarget } from '../../src/inventory.js'
import type { ExpRequest } from '../../src/request.js'
import type { ExpResponse } from '../../src/response.js'

const require = createRequire(import.meta.url)

const express5 = require('express') as ExpressLike
const express4 = require('express4') as ExpressLike

interface ExpressLike {
  (): Record<string, unknown>
  Router: (o?: unknown) => Record<string, unknown>
  Route: new (path: string) => Record<string, unknown>
  request: object
  response: object
  [k: string]: unknown
}

/** Skipped when comparing: `app` is a function, so these always show up. */
const FUNCTION_NOISE = new Set([
  'length',
  'name',
  'arguments',
  'caller',
  'prototype',
  'constructor',
  'apply',
  'bind',
  'call',
  'toString',
])

/** Own keys plus the whole prototype chain. */
function allKeys(obj: unknown): Set<string> {
  const keys = new Set<string>()
  let cur = obj
  while (cur && cur !== Object.prototype && cur !== Function.prototype) {
    for (const k of Object.getOwnPropertyNames(cur)) keys.add(k)
    cur = Object.getPrototypeOf(cur)
  }
  return keys
}

/** Only the keys Express itself puts on the object. */
function expressOwnApi(obj: unknown): string[] {
  return obj ? Object.getOwnPropertyNames(obj).filter((k) => !FUNCTION_NOISE.has(k)) : []
}

/** Keys present in `expected` but missing from `actual`. */
function missing(expectedKeys: string[], actual: unknown): string[] {
  const have = allKeys(actual)
  return expectedKeys.filter((k) => !have.has(k)).sort()
}

/** Runs one request and captures the live req / res. */
async function captureLiveReqRes(): Promise<{ req: ExpRequest; res: ExpResponse }> {
  const app = exphono()
  let captured: { req: ExpRequest; res: ExpResponse } | undefined

  app.use((req, res, next) => {
    captured = { req, res }
    next()
  })
  app.get('/probe', (_req, res) => {
    res.send('ok')
  })

  await app.fetch(new Request('http://localhost/probe?a=1'))
  if (!captured) throw new Error('middleware never ran')
  return captured
}

// ─────────────────────────────────────────────────────────────────────────────
// Does exphono have everything Express defines?
// ─────────────────────────────────────────────────────────────────────────────

describe('module surface', () => {
  for (const [label, ref] of [
    ['express 5', express5],
    ['express 4', express4],
  ] as const) {
    it(`exposes every API ${label} defines`, () => {
      expect(missing(expressOwnApi(ref), exphono)).toEqual([])
    })
  }

  it('is callable and returns an app', () => {
    expect(typeof exphono).toBe('function')
    expect(typeof exphono()).toBe('function')
  })
})

describe('application surface', () => {
  for (const [label, ref] of [
    ['express 5', express5],
    ['express 4', express4],
  ] as const) {
    it(`exposes every API an ${label} app defines`, () => {
      const app = ref()
      const expected = [...expressOwnApi(app), ...expressOwnApi(Object.getPrototypeOf(app))]
      expect(missing(expected, exphono())).toEqual([])
    })
  }

  it('is a function with (req, res, next) arity', () => {
    const app = exphono()
    expect(typeof app).toBe('function')
    expect(app.length).toBe(3)
  })

  it('is an EventEmitter that emits mount', () => {
    const parent = exphono()
    const child = exphono()
    let mountedOn: unknown
    child.on('mount', (p: unknown) => {
      mountedOn = p
    })
    parent.use('/api', child)
    expect(mountedOn).toBe(parent)
    expect(child.parent).toBe(parent)
  })
})

describe('request / response prototypes', () => {
  it('request proto has every member express 5 defines on it', () => {
    expect(missing(expressOwnApi(express5.request), exphono.request)).toEqual([])
  })

  it('response proto has every member express 5 defines on it', () => {
    expect(missing(expressOwnApi(express5.response), exphono.response)).toEqual([])
  })

  it('request proto has every member express 4 defines on it', () => {
    expect(missing(expressOwnApi(express4.request), exphono.request)).toEqual([])
  })

  it('response proto has every member express 4 defines on it', () => {
    expect(missing(expressOwnApi(express4.response), exphono.response)).toEqual([])
  })
})

describe('router / route surface', () => {
  it('Router has every member express 5 defines', () => {
    const ref = express5.Router()
    const expected = [...expressOwnApi(ref), ...expressOwnApi(Object.getPrototypeOf(ref))]
    expect(missing(expected, exphono.Router())).toEqual([])
  })

  it('Route has every member express 5 defines', () => {
    const ref = new express5.Route('/x')
    const expected = [...expressOwnApi(ref), ...expressOwnApi(Object.getPrototypeOf(ref))]
    expect(missing(expected, new exphono.Route('/x'))).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// HTTP verb
// ─────────────────────────────────────────────────────────────────────────────

describe('HTTP verbs', () => {
  it('lists exactly the 35 verbs express uses', () => {
    expect(HTTP_METHODS).toHaveLength(35)
  })

  it('matches express 5 verb-for-verb', () => {
    const ref = express5()
    expect(HTTP_METHODS.filter((v) => typeof ref[v] !== 'function')).toEqual([])
  })

  it.each(HTTP_METHODS)('app has %s', (verb) => {
    expect(typeof (exphono() as unknown as Record<string, unknown>)[verb]).toBe('function')
  })

  it.each(HTTP_METHODS)('Router has %s', (verb) => {
    expect(typeof (exphono.Router() as unknown as Record<string, unknown>)[verb]).toBe('function')
  })

  it.each(HTTP_METHODS)('Route has %s', (verb) => {
    expect(typeof (new exphono.Route('/x') as unknown as Record<string, unknown>)[verb]).toBe(
      'function',
    )
  })

  it('keeps m-search reachable via bracket access', () => {
    expect(typeof (exphono() as unknown as Record<string, unknown>)['m-search']).toBe('function')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Inventory matches the implementation
// ─────────────────────────────────────────────────────────────────────────────

describe('inventory agrees with the implementation', () => {
  const staticTargets: [ApiTarget, () => unknown][] = [
    ['module', () => exphono],
    ['router', () => exphono.Router()],
    ['route', () => new exphono.Route('/x')],
  ]

  for (const [target, make] of staticTargets) {
    it(`every inventory entry for '${target}' exists`, () => {
      const names = surfaceApisFor(target, '5').map((e) => e.name)
      expect(missing(names, make())).toEqual([])
    })
  }

  it("every inventory entry for 'app' exists", async () => {
    // `parent` only exists once mounted
    const parent = exphono()
    const child = exphono()
    parent.use('/api', child)
    const names = surfaceApisFor('app', '5').map((e) => e.name)
    expect(missing(names, child)).toEqual([])
  })

  it("every inventory entry for 'request' exists on a live request", async () => {
    const { req } = await captureLiveReqRes()
    const names = surfaceApisFor('request', '5').map((e) => e.name)
    expect(missing(names, req)).toEqual([])
  })

  it("every inventory entry for 'response' exists on a live response", async () => {
    const { res } = await captureLiveReqRes()
    const names = surfaceApisFor('response', '5').map((e) => e.name)
    expect(missing(names, res)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The declared Node-compatible subset
// ─────────────────────────────────────────────────────────────────────────────

describe('Node compatibility subset', () => {
  it('req carries the socket fields middleware reads', async () => {
    const { req } = await captureLiveReqRes()
    expect(req.socket).toBeDefined()
    expect(req.connection).toBe(req.socket)
    expect(req.httpVersion).toBe('1.1')
    expect(typeof req.socket.setTimeout).toBe('function')
  })

  it('res exposes the ServerResponse methods header middleware uses', async () => {
    const { res } = await captureLiveReqRes()
    for (const m of [
      'writeHead',
      'setHeader',
      'getHeader',
      'getHeaders',
      'getHeaderNames',
      'hasHeader',
      'removeHeader',
      'flushHeaders',
      'write',
      'end',
    ]) {
      expect(typeof (res as unknown as Record<string, unknown>)[m]).toBe('function')
    }
  })

  it('calls writeHead internally when headers commit (on-headers hook)', async () => {
    // on-headers hooks by replacing res.writeHead, so exphono must call it internally
    const app = exphono()
    let hooked = false

    app.use((_req, res, next) => {
      const original = res.writeHead.bind(res)
      res.writeHead = ((...args: Parameters<typeof original>) => {
        hooked = true
        return original(...args)
      }) as typeof res.writeHead
      next()
    })
    app.get('/', (_req, res) => {
      res.send('body')
    })

    await app.fetch(new Request('http://localhost/'))
    expect(hooked).toBe(true)
  })

  it('emits finish when the response completes', async () => {
    const app = exphono()
    let finished = false

    app.use((_req, res, next) => {
      res.on('finish', () => {
        finished = true
      })
      next()
    })
    app.get('/', (_req, res) => {
      res.send('ok')
    })

    await app.fetch(new Request('http://localhost/'))
    expect(finished).toBe(true)
  })
})
