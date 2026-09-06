/**
 * Routing semantics that are easy to get subtly wrong: parameter scoping across router
 * boundaries, named captures, wildcards, and handler validation.
 */

import { describe, expect, it } from 'vitest'
import express from '../../src/index.js'

function get(app: ReturnType<typeof express>, path: string): Promise<globalThis.Response> {
  return app.fetch(new Request(`http://localhost${path}`))
}

describe('req.params scoping', () => {
  it('a nested router does not see the parent route params', async () => {
    const app = express()
    const router = express.Router()
    let seenInside: unknown

    router.use((req, _res, next) => {
      seenInside = req.params.id
      next()
    })
    app.get(
      '/user/:id',
      router,
      (req, res) => {
        res.send(String(req.params.id))
      },
    )

    const res = await get(app, '/user/1')
    expect(seenInside).toBeUndefined()
    // and the parent's params are back afterwards
    expect(await res.text()).toBe('1')
  })

  it('mergeParams brings the parent params through', async () => {
    const app = express()
    const router = express.Router({ mergeParams: true })

    router.get('/detail', (req, res) => {
      res.json(req.params)
    })
    app.use('/user/:id', router)

    expect(await (await get(app, '/user/7/detail')).json()).toEqual({ id: '7' })
  })

  it('without mergeParams the parent params are not visible', async () => {
    const app = express()
    const router = express.Router()

    router.get('/detail', (req, res) => {
      res.json(req.params)
    })
    app.use('/user/:id', router)

    expect(await (await get(app, '/user/7/detail')).json()).toEqual({})
  })
})

describe('path matching', () => {
  it('a mount path with a trailing slash still matches deeper paths', async () => {
    // Non-strict mounts strip a trailing slash before compiling, then accept it back
    // optionally — '/foo/bob/' has to keep matching '/foo/bob/bar', not just '/foo/bob/'.
    // (Without mergeParams, the sub-router does not see :user — verified against real
    // Express, which returns {} here too.)
    const app = express()
    const router = express.Router()
    router.get('/bar', (req, res) => res.json(req.params))
    app.use('/:user/bob/', router)

    const res = await get(app, '/foo/bob/bar')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({})
  })

  it('exposes named captures from an inline RegExp', async () => {
    const app = express()
    app.get(/^\/user\/(?<userId>[0-9]+)$/, (req, res) => {
      res.send(String(req.params.userId))
    })

    expect(await (await get(app, '/user/42')).text()).toBe('42')
  })

  it('collects wildcard segments into an array', async () => {
    const app = express()
    app.get('/files/*path', (req, res) => {
      res.json(req.params.path)
    })

    expect(await (await get(app, '/files/a/b/c')).json()).toEqual(['a', 'b', 'c'])
  })

  it('answers 400 for a malformed percent escape', async () => {
    const app = express()
    app.get('/:name', (req, res) => {
      res.send(String(req.params.name))
    })

    expect((await get(app, '/%foobar')).status).toBe(400)
  })

  it('decodes percent-encoded parameters', async () => {
    const app = express()
    app.get('/:name', (req, res) => {
      res.send(String(req.params.name))
    })

    expect(await (await get(app, '/caf%C3%A9')).text()).toBe('café')
  })
})

describe('handler validation', () => {
  it('rejects a non-function handler on a verb method', () => {
    const app = express()
    expect(() => app.get('/', 3 as never)).toThrow(/argument handler must be a function/)
  })

  it('rejects a non-function handler on app.all', () => {
    const app = express()
    expect(() => app.all('/', 'nope' as never)).toThrow(/argument handler must be a function/)
  })

  it('accepts nested arrays of handlers', async () => {
    const app = express()
    const mark = (name: string) => (_req: never, res: { append: (k: string, v: string) => void }, next: () => void) => {
      res.append('x-mark', name)
      next()
    }

    app.get('/', [mark('a'), [mark('b')]] as never, (_req, res) => {
      res.send('ok')
    })

    const res = await get(app, '/')
    expect(res.headers.get('x-mark')).toBe('a, b')
  })

  it('rejects a non-function handler on Route.all', () => {
    const app = express()
    expect(() => app.route('/').all(3 as never)).toThrow(/argument handler must be a function/)
  })

  it('router.param requires a function', () => {
    const router = express.Router()
    expect(() => router.param('id', undefined as never)).toThrow(/argument fn is required/)
    expect(() => router.param('id', 42 as never)).toThrow(/argument fn must be a function/)
  })
})
