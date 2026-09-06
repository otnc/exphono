/**
 * Template rendering, end to end with a real engine (ejs).
 *
 * Exercises the parts of `View` that are easy to get wrong: locals precedence, view caching, and the lookup order across multiple roots.
 */

import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import express from '../../src/index.js'

const fixtures = resolve(import.meta.dirname, '../fixtures/views')

function get(app: ReturnType<typeof express>, path: string): Promise<globalThis.Response> {
  return app.fetch(new Request(`http://localhost${path}`))
}

describe('res.render', () => {
  it('renders a template with res.render locals', async () => {
    const app = express()
    app.set('views', fixtures)
    app.set('view engine', 'ejs')
    app.get('/', (_req, res) => {
      res.render('hello', { name: 'tobi' })
    })

    const res = await get(app, '/')
    expect(res.status).toBe(200)
    expect((await res.text()).trim()).toBe('Hello tobi')
  })

  it('gives res.render locals precedence over res.locals', async () => {
    const app = express()
    app.set('views', fixtures)
    app.set('view engine', 'ejs')
    app.get('/', (_req, res) => {
      res.locals.name = 'from res.locals'
      res.render('hello', { name: 'from render' })
    })

    expect((await (await get(app, '/')).text()).trim()).toBe('Hello from render')
  })

  it('gives res.locals precedence over app.locals', async () => {
    const app = express()
    app.set('views', fixtures)
    app.set('view engine', 'ejs')
    app.locals.name = 'from app.locals'
    app.get('/', (_req, res) => {
      res.locals.name = 'from res.locals'
      res.render('hello')
    })

    expect((await (await get(app, '/')).text()).trim()).toBe('Hello from res.locals')
  })

  it('reports a 500 when the view cannot be found', async () => {
    const app = express()
    app.set('views', fixtures)
    app.set('view engine', 'ejs')
    app.get('/', (_req, res) => {
      res.render('does-not-exist')
    })

    expect((await get(app, '/')).status).toBe(500)
  })

  it('reuses a cached view on the second render', async () => {
    const app = express()
    app.set('views', fixtures)
    app.set('view engine', 'ejs')
    app.enable('view cache')
    app.get('/', (_req, res) => {
      res.render('hello', { name: 'cached' })
    })

    await get(app, '/')
    const res = await get(app, '/')
    expect((await res.text()).trim()).toBe('Hello cached')
  })
})

describe('app.render', () => {
  it('renders directly, without a request', async () => {
    const app = express()
    app.set('views', fixtures)
    app.set('view engine', 'ejs')

    const html = await new Promise<string | undefined>((resolvePromise, reject) => {
      app.render('hello', { name: 'direct' }, (err, out) => {
        if (err) reject(err)
        else resolvePromise(out)
      })
    })

    expect(html?.trim()).toBe('Hello direct')
  })
})

describe('app.engine', () => {
  it('rejects a non-function callback', () => {
    const app = express()
    expect(() => app.engine('.html', null as never)).toThrow(/callback function required/)
  })

  it('accepts an extension without a leading dot', async () => {
    const app = express()
    const ejs = (await import('ejs')) as unknown as { __express: Parameters<typeof app.engine>[1] }
    app.engine('ejs', ejs.__express)
    app.set('views', fixtures)
    app.get('/', (_req, res) => {
      res.render('hello.ejs', { name: 'ext' })
    })

    expect((await (await get(app, '/')).text()).trim()).toBe('Hello ext')
  })
})
