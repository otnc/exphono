import { describe, expect, it } from 'vitest'
// Aliased: Express's Request / Response shadow the Fetch globals of the same name
import type { Request as ExRequest, Response as ExResponse, NextFunction } from './index.js'
import express from './index.js'

/** Sends a request through app.fetch. */
function call(
  app: ReturnType<typeof express>,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return app.fetch(new Request(`http://localhost${path}`, init))
}

describe('hello world', () => {
  it('responds to a simple GET', async () => {
    const app = express()
    app.get('/', (_req, res) => {
      res.send('Hello, exphono!')
    })

    const res = await call(app, '/')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('Hello, exphono!')
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
  })

  it('sends JSON', async () => {
    const app = express()
    app.get('/api', (_req, res) => {
      res.json({ ok: true, n: 42 })
    })

    const res = await call(app, '/api')
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.json()).toEqual({ ok: true, n: 42 })
  })

  it('404s an unknown path with the Express message', async () => {
    const app = express()
    const res = await call(app, '/nope')
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('Cannot GET /nope')
  })
})

describe('route params', () => {
  it('captures a named parameter', async () => {
    const app = express()
    app.get('/users/:id', (req, res) => {
      res.json({ id: req.params.id })
    })

    expect(await (await call(app, '/users/42')).json()).toEqual({ id: '42' })
  })

  it('captures multiple parameters', async () => {
    const app = express()
    app.get('/a/:x/b/:y', (req, res) => {
      res.json(req.params)
    })

    expect(await (await call(app, '/a/1/b/2')).json()).toEqual({ x: '1', y: '2' })
  })

  it('decodes percent-encoded values', async () => {
    const app = express()
    app.get('/u/:name', (req, res) => {
      res.json({ name: req.params.name })
    })

    expect(await (await call(app, '/u/%E7%8C%AB')).json()).toEqual({ name: '猫' })
  })

  it('does not match a different path', async () => {
    const app = express()
    app.get('/users/:id', (_req, res) => {
      res.send('hit')
    })

    expect((await call(app, '/other')).status).toBe(404)
  })
})

describe('middleware chain', () => {
  it('runs middleware in registration order', async () => {
    const app = express()
    const order: string[] = []

    app.use((_req, _res, next) => {
      order.push('first')
      next()
    })
    app.use((_req, _res, next) => {
      order.push('second')
      next()
    })
    app.get('/', (_req, res) => {
      order.push('handler')
      res.send('done')
    })

    await call(app, '/')
    expect(order).toEqual(['first', 'second', 'handler'])
  })

  it('lets middleware mutate the request', async () => {
    const app = express()
    app.use((req, _res, next) => {
      ;(req as unknown as { user: string }).user = 'otoneko'
      next()
    })
    app.get('/me', (req, res) => {
      res.json({ user: (req as unknown as { user: string }).user })
    })

    expect(await (await call(app, '/me')).json()).toEqual({ user: 'otoneko' })
  })

  it('stops the chain when next() is not called', async () => {
    const app = express()
    let reached = false

    app.use((_req, res) => {
      res.status(401).send('nope')
    })
    app.get('/', (_req, res) => {
      reached = true
      res.send('never')
    })

    const res = await call(app, '/')
    expect(res.status).toBe(401)
    expect(reached).toBe(false)
  })

  it('scopes path-mounted middleware to that prefix', async () => {
    const app = express()
    const seen: string[] = []

    app.use('/api', (_req, _res, next) => {
      seen.push('api-mw')
      next()
    })
    app.get('/api/x', (_req, res) => {
      res.send('x')
    })
    app.get('/other', (_req, res) => {
      res.send('other')
    })

    await call(app, '/other')
    expect(seen).toEqual([])

    await call(app, '/api/x')
    expect(seen).toEqual(['api-mw'])
  })
})

describe('error handling', () => {
  it('routes a thrown error to the 4-arg handler', async () => {
    const app = express()
    app.get('/boom', () => {
      throw new Error('kaboom')
    })
    app.use((err: unknown, _req: ExRequest, res: ExResponse, _next: NextFunction) => {
      res.status(500).json({ message: (err as Error).message })
    })

    const res = await call(app, '/boom')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ message: 'kaboom' })
  })

  it('routes next(err) to the error handler', async () => {
    const app = express()
    app.get('/e', (_req, _res, next) => {
      next(new Error('explicit'))
    })
    app.use((err: unknown, _req: ExRequest, res: ExResponse, _next: NextFunction) => {
      res.status(400).send((err as Error).message)
    })

    const res = await call(app, '/e')
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('explicit')
  })

  it('skips non-error middleware once an error is in flight', async () => {
    const app = express()
    const seen: string[] = []

    app.get('/e', (_req, _res, next) => {
      next(new Error('x'))
    })
    app.use((_req, _res, next) => {
      seen.push('should-be-skipped')
      next()
    })
    app.use((_err: unknown, _req: ExRequest, res: ExResponse, _next: NextFunction) => {
      seen.push('error-handler')
      res.status(500).send('handled')
    })

    await call(app, '/e')
    expect(seen).toEqual(['error-handler'])
  })

  it('falls back to the default handler with a 500', async () => {
    const app = express()
    app.get('/boom', () => {
      throw new Error('unhandled')
    })

    const res = await call(app, '/boom')
    expect(res.status).toBe(500)
  })

  it('honours err.status', async () => {
    const app = express()
    app.get('/e', (_req, _res, next) => {
      const err = Object.assign(new Error('teapot'), { status: 418 })
      next(err)
    })

    expect((await call(app, '/e')).status).toBe(418)
  })
})

describe('body parsing', () => {
  it('parses JSON bodies', async () => {
    const app = express()
    app.use(express.json())
    app.post('/echo', (req, res) => {
      res.json(req.body)
    })

    const res = await call(app, '/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1, b: 'two' }),
    })
    expect(await res.json()).toEqual({ a: 1, b: 'two' })
  })

  it('ignores bodies whose content-type does not match', async () => {
    const app = express()
    app.use(express.json())
    app.post('/echo', (req, res) => {
      res.json({ body: req.body ?? null })
    })

    const res = await call(app, '/echo', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'not json',
    })
    expect(await res.json()).toEqual({ body: null })
  })

  it('parses urlencoded bodies', async () => {
    const app = express()
    app.use(express.urlencoded({ extended: false }))
    app.post('/form', (req, res) => {
      res.json(req.body)
    })

    const res = await call(app, '/form', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'name=otoneko&lang=ja',
    })
    expect(await res.json()).toEqual({ name: 'otoneko', lang: 'ja' })
  })

  it('rejects a body over the limit with 413', async () => {
    const app = express()
    app.use(express.json({ limit: 10 }))
    app.post('/echo', (req, res) => {
      res.json(req.body)
    })

    const res = await call(app, '/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(100) }),
    })
    expect(res.status).toBe(413)
  })
})

describe('Router', () => {
  it('mounts a router under a prefix', async () => {
    const app = express()
    const router = express.Router()

    router.get('/list', (_req, res) => {
      res.json({ items: [] })
    })
    app.use('/api', router)

    expect((await call(app, '/api/list')).status).toBe(200)
    expect((await call(app, '/list')).status).toBe(404)
  })

  it('exposes baseUrl and originalUrl inside a mounted router', async () => {
    const app = express()
    const router = express.Router()

    router.get('/deep', (req, res) => {
      res.json({ baseUrl: req.baseUrl, url: req.url, originalUrl: req.originalUrl })
    })
    app.use('/api', router)

    expect(await (await call(app, '/api/deep')).json()).toEqual({
      baseUrl: '/api',
      url: '/deep',
      originalUrl: '/api/deep',
    })
  })
})

describe('response helpers', () => {
  it('sets status and headers', async () => {
    const app = express()
    app.get('/', (_req, res) => {
      res.status(201).set('x-custom', 'yes').send('created')
    })

    const res = await call(app, '/')
    expect(res.status).toBe(201)
    expect(res.headers.get('x-custom')).toBe('yes')
  })

  it('redirects', async () => {
    const app = express()
    app.get('/go', (_req, res) => {
      res.redirect('/there')
    })

    const res = await call(app, '/go', { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/there')
  })

  it('supports res.type', async () => {
    const app = express()
    app.get('/', (_req, res) => {
      res.type('json').send('{"raw":true}')
    })

    expect((await call(app, '/')).headers.get('content-type')).toBe(
      'application/json; charset=utf-8',
    )
  })

  it('streams via write/end', async () => {
    const app = express()
    app.get('/stream', (_req, res) => {
      res.write('a')
      res.write('b')
      res.end('c')
    })

    expect(await (await call(app, '/stream')).text()).toBe('abc')
  })

  it('omits the body for 204', async () => {
    const app = express()
    app.get('/none', (_req, res) => {
      res.status(204).send('ignored')
    })

    const res = await call(app, '/none')
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })
})

describe('req properties', () => {
  it('exposes method, path and query', async () => {
    const app = express()
    app.get('/search', (req, res) => {
      res.json({ method: req.method, path: req.path, url: req.url })
    })

    expect(await (await call(app, '/search?q=cat')).json()).toEqual({
      method: 'GET',
      path: '/search',
      url: '/search?q=cat',
    })
  })

  it('reads headers case-insensitively', async () => {
    const app = express()
    app.get('/h', (req, res) => {
      res.json({ ua: req.get('User-Agent'), lower: req.get('user-agent') })
    })

    const res = await call(app, '/h', { headers: { 'user-agent': 'spike/1.0' } })
    expect(await res.json()).toEqual({ ua: 'spike/1.0', lower: 'spike/1.0' })
  })

  it('exposes the Hono context and the raw Request', async () => {
    const app = express()
    app.get('/hono', (req, res) => {
      res.json({ hasCtx: typeof req.hono === 'object', isRequest: req.raw instanceof Request })
    })

    expect(await (await call(app, '/hono')).json()).toEqual({ hasCtx: true, isRequest: true })
  })
})
