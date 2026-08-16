/**
 * Runs the edge build on a real workerd via miniflare.
 *
 * Bundled first, as a real deployment would be: the edge build keeps `hono` external
 * because it is a peer dependency, so wrangler (or here, rolldown) has to inline it.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Miniflare } from 'miniflare'
import { rolldown } from 'rolldown'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const ready = existsSync(join(root, 'dist/edge/index.mjs'))
const scratch = join(root, '.worker-tmp')

const instances: Miniflare[] = []

/** Bundles a worker and starts it on workerd. */
async function startWorker(name: string, body: string): Promise<Miniflare> {
  mkdirSync(scratch, { recursive: true })
  const entry = join(scratch, `${name}.mjs`)
  writeFileSync(entry, `import express from 'exphono'\n${body}`)

  const bundle = await rolldown({
    input: entry,
    platform: 'neutral',
    // Inline everything, like wrangler does
    external: [],
  })
  const { output } = await bundle.generate({ format: 'esm' })
  await bundle.close()

  const mf = new Miniflare({
    modules: true,
    script: output[0].code,
    compatibilityDate: '2026-01-01',
  })
  instances.push(mf)
  return mf
}

beforeAll(() => {
  mkdirSync(scratch, { recursive: true })
})

afterAll(async () => {
  await Promise.all(instances.map((mf) => mf.dispose().catch(() => {})))
  rmSync(scratch, { recursive: true, force: true })
})

describe.skipIf(!ready)('Cloudflare Workers (workerd)', () => {
  it('serves a hello world through app.worker', async () => {
    const mf = await startWorker(
      'hello',
      `const app = express()
       app.get('/', (req, res) => res.send('hello from workerd'))
       export default app.worker`,
    )
    const res = await mf.dispatchFetch('http://localhost/')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('hello from workerd')
  })

  it('runs a middleware chain and route params', async () => {
    const mf = await startWorker(
      'chain',
      `const app = express()
       app.use((req, res, next) => { req.stamp = 'mw'; next() })
       app.get('/users/:id', (req, res) => res.json({ id: req.params.id, stamp: req.stamp }))
       export default app.worker`,
    )
    const res = await mf.dispatchFetch('http://localhost/users/42')
    expect(await res.json()).toEqual({ id: '42', stamp: 'mw' })
  })

  it('parses a JSON body', async () => {
    const mf = await startWorker(
      'json',
      `const app = express()
       app.use(express.json())
       app.post('/echo', (req, res) => res.json(req.body))
       export default app.worker`,
    )
    const res = await mf.dispatchFetch('http://localhost/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ edge: true }),
    })
    expect(await res.json()).toEqual({ edge: true })
  })

  it('routes errors to the error handler', async () => {
    const mf = await startWorker(
      'error',
      `const app = express()
       app.get('/boom', () => { throw new Error('edge boom') })
       app.use((err, req, res, next) => res.status(500).json({ message: err.message }))
       export default app.worker`,
    )
    const res = await mf.dispatchFetch('http://localhost/boom')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ message: 'edge boom' })
  })

  it('404s unknown routes', async () => {
    const mf = await startWorker(
      'notfound',
      `const app = express()
       export default app.worker`,
    )
    const res = await mf.dispatchFetch('http://localhost/nope')
    expect(res.status).toBe(404)
  })

  it('mounts a Router under a prefix', async () => {
    const mf = await startWorker(
      'router',
      `const app = express()
       const api = express.Router()
       api.get('/list', (req, res) => res.json({ baseUrl: req.baseUrl, url: req.url }))
       app.use('/api', api)
       export default app.worker`,
    )
    const res = await mf.dispatchFetch('http://localhost/api/list')
    expect(await res.json()).toEqual({ baseUrl: '/api', url: '/list' })
  })

  it('exposes the Hono context and env bindings on req', async () => {
    const mf = await startWorker(
      'env',
      `const app = express()
       app.get('/env', (req, res) => res.json({
         hasCtx: typeof req.hono === 'object',
         isRequest: req.raw instanceof Request,
       }))
       export default app.worker`,
    )
    expect(await (await mf.dispatchFetch('http://localhost/env')).json()).toEqual({
      hasCtx: true,
      isRequest: true,
    })
  })

  it('also accepts export default app.hono', async () => {
    const mf = await startWorker(
      'hono',
      `const app = express()
       app.get('/', (req, res) => res.send('via hono'))
       export default app.hono`,
    )
    expect(await (await mf.dispatchFetch('http://localhost/')).text()).toBe('via hono')
  })

  it('rejects `export default app` — workerd treats a function as an actor class', async () => {
    // `app` is a function for Express compatibility, and workerd reads a function
    // default export as a Durable Object class, ignoring `.fetch` — hence `app.worker`.
    const mf = await startWorker(
      'bad',
      `const app = express()
       app.get('/', (req, res) => res.send('never'))
       export default app`,
    )
    const res = await mf.dispatchFetch('http://localhost/')
    expect(res.status).toBe(500)
  })
})
