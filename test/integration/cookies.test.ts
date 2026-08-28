/**
 * Signed cookies, end to end with the real cookie-parser.
 *
 * The signature has to match `cookie-signature` byte for byte, otherwise cookies written
 * by exphono cannot be read back by an Express app and vice versa.
 */

import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import express from '../../src/index.js'
import type { RequestHandler } from '../../src/router/index.js'

const require = createRequire(import.meta.url)
const cookieParser = require('cookie-parser')
const signature = require('cookie-signature')

const SECRET = 'foo bar baz'

function appWithParser(handler: RequestHandler) {
  const app = express()
  app.use(cookieParser(SECRET))
  app.use(handler)
  return app
}

describe('signed cookies', () => {
  it('signs a value the way cookie-signature does', async () => {
    const app = appWithParser((_req, res) => {
      res.cookie('name', 'tobi', { signed: true }).end()
    })

    const res = await app.fetch(new Request('http://localhost/'))
    const cookie = res.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(encodeURIComponent(`s:${signature.sign('tobi', SECRET)}`))
  })

  it('signs a JSON value', async () => {
    const app = appWithParser((_req, res) => {
      res.cookie('user', { name: 'tobi' }, { signed: true }).end()
    })

    const res = await app.fetch(new Request('http://localhost/'))
    const expected = `s:${signature.sign('j:{"name":"tobi"}', SECRET)}`
    expect(res.headers.get('set-cookie')).toBe(`user=${encodeURIComponent(expected)}; Path=/`)
  })

  it('throws without a secret', async () => {
    const app = express()
    app.use(cookieParser())
    app.use((_req, res) => {
      res.cookie('name', 'tobi', { signed: true }).end()
    })

    const res = await app.fetch(new Request('http://localhost/'))
    expect(res.status).toBe(500)
  })

  it('reads back a cookie signed by cookie-signature', async () => {
    const app = appWithParser((req, res) => {
      res.json({ signed: req.signedCookies?.name, plain: req.cookies?.plain })
    })

    const signed = encodeURIComponent(`s:${signature.sign('tobi', SECRET)}`)
    const res = await app.fetch(
      new Request('http://localhost/', { headers: { cookie: `name=${signed}; plain=value` } }),
    )
    expect(await res.json()).toEqual({ signed: 'tobi', plain: 'value' })
  })

  it('sends Max-Age and Expires together, like Express', async () => {
    const app = appWithParser((_req, res) => {
      res.cookie('name', 'tobi', { maxAge: 1000 }).end()
    })

    const cookie = (await app.fetch(new Request('http://localhost/'))).headers.get('set-cookie')
    expect(cookie).toMatch(/name=tobi; Max-Age=1; Path=\/; Expires=/)
  })

  it('rejects an invalid maxAge', async () => {
    const app = appWithParser((_req, res) => {
      res.cookie('name', 'tobi', { maxAge: Number.NaN }).end()
    })

    expect((await app.fetch(new Request('http://localhost/'))).status).toBe(500)
  })

  it('leaves req.cookies unset so cookie-parser still runs', async () => {
    // cookie-parser returns early when req.cookies already exists
    const app = express()
    let sawSecret: string | undefined
    app.use(cookieParser(SECRET))
    app.use((req, res) => {
      sawSecret = req.secret
      res.end()
    })

    await app.fetch(new Request('http://localhost/'))
    expect(sawSecret).toBe(SECRET)
  })
})
