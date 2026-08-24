/**
 * The function object `express()` returns.
 *
 * `app` has to be a function for `app.use('/sub', subApp)` and `http.createServer(app)`
 * to work. As a consequence `export default app` cannot be used on Workers: workerd
 * reads a function default export as a Durable Object class and never looks at `.fetch`.
 * Deploy with `app.worker` instead.
 */

import type { Context } from 'hono'
import { Hono } from 'hono'
import { ExphonoError, report, setGlobalStrict } from './diagnostics.js'
import { type CompatMode, HTTP_METHODS, type HttpMethod } from './inventory.js'
import { finalHandler } from './middleware/final-handler.js'
import { createAppProto, kState } from './object-model.js'
import { createRequest, type ExpRequest, requestProto } from './request.js'
import { abortResponse, createResponse, type ExpResponse, responseProto } from './response.js'
import {
  createRouter,
  type ErrorRequestHandler,
  type NextFunction,
  type ParamCallback,
  type RequestHandler,
  type Route,
  type RouterInstance,
  setPromiseErrorForwarding,
  splitPathAndHandlers,
} from './router/index.js'
import type { PathSpec } from './router/matcher.js'
import { mixinEmitter } from './runtime/event-emitter.js'
import { handleNodeRequest, serve } from './runtime/serve.js'

export interface ExphonoOptions {
  strict?: boolean
  compat?: CompatMode
}

/** Anything `app.use()` accepts. */
export type Mountable = RequestHandler | ErrorRequestHandler | Application | RouterInstance

/**
 * Route registration per HTTP verb. `get` is declared separately: it is overloaded
 * with reading a setting.
 */
export type VerbMethods = {
  [K in Exclude<HttpMethod, 'get'>]: (path: PathSpec, ...handlers: RequestHandler[]) => Application
}

type EmitterListener = (...args: never[]) => void

/**
 * An app is also an EventEmitter; `app.on('mount', ...)` is public API.
 */
export interface ApplicationEvents {
  on(event: string, listener: EmitterListener): Application
  once(event: string, listener: EmitterListener): Application
  off(event: string, listener: EmitterListener): Application
  addListener(event: string, listener: EmitterListener): Application
  removeListener(event: string, listener: EmitterListener): Application
  removeAllListeners(event?: string): Application
  prependListener(event: string, listener: EmitterListener): Application
  prependOnceListener(event: string, listener: EmitterListener): Application
  emit(event: string, ...args: unknown[]): boolean
  listeners(event: string): EmitterListener[]
  rawListeners(event: string): EmitterListener[]
  listenerCount(event: string): number
  eventNames(): (string | symbol)[]
  setMaxListeners(n: number): Application
  getMaxListeners(): number
}

export interface Application extends VerbMethods, ApplicationEvents {
  (req: ExpRequest, res: ExpResponse, next: NextFunction): void

  // Express API
  locals: Record<string, unknown>
  settings: Record<string, unknown>
  engines: Record<string, unknown>
  cache: Record<string, unknown>
  mountpath: string | string[]
  parent?: Application
  request: ExpRequest
  response: ExpResponse

  set(key: string): unknown
  set(key: string, value: unknown): Application
  /** One argument reads a setting; more registers a route. */
  get(setting: string): unknown
  get(path: PathSpec, ...handlers: RequestHandler[]): Application
  all(path: PathSpec, ...handlers: RequestHandler[]): Application
  del(path: PathSpec, ...handlers: RequestHandler[]): Application
  enable(key: string): Application
  disable(key: string): Application
  enabled(key: string): boolean
  disabled(key: string): boolean
  // Concrete shapes first so arrow parameters get inferred: three arguments match
  // RequestHandler, four fall through to ErrorRequestHandler.
  use(handler: RequestHandler): Application
  use(handler: ErrorRequestHandler): Application
  use(path: PathSpec, handler: RequestHandler): Application
  use(path: PathSpec, handler: ErrorRequestHandler): Application
  use(...handlers: RequestHandler[]): Application
  use(...handlers: ErrorRequestHandler[]): Application
  use(path: PathSpec, ...handlers: RequestHandler[]): Application
  use(path: PathSpec, ...handlers: ErrorRequestHandler[]): Application
  use(...handlers: Mountable[]): Application
  use(path: PathSpec, ...handlers: Mountable[]): Application
  route(path: string): Route
  param(name: string, fn: ParamCallback): Application
  path(): string
  handle(req: ExpRequest, res: ExpResponse, next?: NextFunction): void
  init(): void
  defaultConfiguration(): void
  engine(ext: string, fn: unknown): Application
  render(view: string, options?: unknown, callback?: (err?: unknown, html?: string) => void): void
  listen(...args: unknown[]): unknown

  // exphono additions
  readonly hono: Hono
  fetch(request: Request, env?: unknown, ctx?: unknown): Promise<Response>
  /** The supported edge entry point: `export default app.worker`. */
  readonly worker: { fetch: (request: Request, env?: unknown, ctx?: unknown) => Promise<Response> }
  configure(options: ExphonoOptions): Application
}

const DEFAULT_SETTINGS_V4: Record<string, unknown> = {
  etag: 'weak',
  'query parser': 'extended',
  'subdomain offset': 2,
  'trust proxy': false,
  'jsonp callback name': 'callback',
  'x-powered-by': true,
}

const DEFAULT_SETTINGS_V5: Record<string, unknown> = {
  ...DEFAULT_SETTINGS_V4,
  'query parser': 'simple',
}

export function createApplication(compatDefault: CompatMode = '5'): Application {
  const app = ((req: ExpRequest, res: ExpResponse, next: NextFunction) => {
    // http.createServer(app) and supertest call this with real Node objects
    if (isNodeReqRes(req, res)) {
      void handleNodeRequest(app, req as never, res as never)
      return
    }
    app.handle(req, res, next)
  }) as Application

  mixinEmitter(app)

  let compat: CompatMode = compatDefault
  let strict: boolean | undefined

  const settings: Record<string, unknown> = Object.create(null)
  const hono = new Hono()

  Object.assign(settings, compat === '4' ? DEFAULT_SETTINGS_V4 : DEFAULT_SETTINGS_V5)
  settings.env = readEnv()

  app.settings = settings
  app.locals = Object.create(null) as Record<string, unknown>
  app.engines = Object.create(null) as Record<string, unknown>
  app.cache = Object.create(null) as Record<string, unknown>
  app.mountpath = '/'

  // Per-app prototypes
  app.request = createAppProto(requestProto, app)
  app.response = createAppProto(responseProto, app)

  const router: RouterInstance = createRouter({
    compat,
    caseSensitive: false,
    strict: false,
  })

  // Settings
  Object.defineProperty(app, 'set', {
    writable: true,
    configurable: true,
    value(key: string, ...rest: unknown[]) {
      if (rest.length === 0) return settings[key]
      const value = rest[0]
      settings[key] = value
      if (key === 'exphono strict') strict = Boolean(value)
      if (key === 'exphono compat') compat = String(value) as CompatMode
      return app
    },
  })

  Object.defineProperty(app, 'get', {
    writable: true,
    configurable: true,
    // One argument reads a setting, even when it looks like a path
    value(path: string, ...handlers: RequestHandler[]) {
      if (handlers.length === 0) return settings[path]
      ;(router as unknown as Record<string, (p: PathSpec, ...h: RequestHandler[]) => unknown>).get(
        path,
        ...handlers,
      )
      return app
    },
  })

  app.enable = (key: string) => {
    settings[key] = true
    return app
  }
  app.disable = (key: string) => {
    settings[key] = false
    return app
  }
  app.enabled = (key: string) => Boolean(settings[key])
  app.disabled = (key: string) => !settings[key]

  app.configure = (options: ExphonoOptions) => {
    if (options.strict !== undefined) {
      strict = options.strict
      setGlobalStrict(options.strict)
    }
    if (options.compat !== undefined) compat = options.compat
    return app
  }

  // Routing
  app.use = (...args: unknown[]) => {
    const { path, handlers } = splitPathAndHandlers(args)
    if (handlers.length === 0) throw new TypeError('app.use() requires a middleware function')

    for (const h of handlers) {
      if (typeof h !== 'function') throw new TypeError('argument handler must be a function')

      const sub = h as Partial<Application>
      if (sub.handle && sub.set && sub.settings) {
        mountSubApp(app, router, path, h as Application)
        continue
      }
      router.use(path, h as RequestHandler)
    }
    return app
  }

  app.route = (path: string) => router.route(path)
  app.param = (name: string, fn: ParamCallback) => {
    router.param(name, fn)
    return app
  }

  app.path = () => (app.parent ? app.parent.path() + String(app.mountpath) : '')

  for (const verb of HTTP_METHODS) {
    if (verb === 'get') continue // overloaded above
    Object.defineProperty(app, verb, {
      writable: true,
      configurable: true,
      enumerable: false,
      value(path: PathSpec, ...handlers: RequestHandler[]) {
        ;(router as unknown as Record<string, (p: PathSpec, ...h: RequestHandler[]) => unknown>)[
          verb
        ](path, ...handlers)
        return app
      },
    })
  }

  Object.defineProperty(app, 'all', {
    writable: true,
    configurable: true,
    value(path: PathSpec, ...handlers: RequestHandler[]) {
      router.all(path, ...handlers)
      return app
    },
  })

  // Deprecated Express 4 alias
  Object.defineProperty(app, 'del', {
    writable: true,
    configurable: true,
    enumerable: false,
    value(path: PathSpec, ...handlers: RequestHandler[]) {
      if (compat !== '4') report('EXPHONO_E008', { strict, context: 'app.del' })
      ;(
        router as unknown as Record<string, (p: PathSpec, ...h: RequestHandler[]) => unknown>
      ).delete(path, ...handlers)
      return app
    },
  })

  app.init = () => {}

  /** Restores the default settings. */
  Object.defineProperty(app, 'defaultConfiguration', {
    writable: true,
    configurable: true,
    enumerable: false,
    value: () => {
      Object.assign(settings, compat === '4' ? DEFAULT_SETTINGS_V4 : DEFAULT_SETTINGS_V5)
      settings.env = readEnv()
    },
  })

  /** Registers a template engine; rendering is not implemented yet. */
  Object.defineProperty(app, 'engine', {
    writable: true,
    configurable: true,
    enumerable: false,
    value: (ext: string, fn: unknown) => {
      const key = ext.startsWith('.') ? ext : `.${ext}`
      app.engines[key] = fn
      return app
    },
  })

  Object.defineProperty(app, 'render', {
    writable: true,
    configurable: true,
    enumerable: false,
    value: (_view: string, _options?: unknown, callback?: (e?: unknown) => void) => {
      const err = new ExphonoError('EXPHONO_E002', 'app.render')
      const cb = typeof _options === 'function' ? (_options as (e?: unknown) => void) : callback
      if (cb) {
        cb(err)
        return
      }
      throw err
    },
  })

  Object.defineProperty(app, 'lazyrouter', {
    writable: true,
    configurable: true,
    enumerable: false,
    value: () => {},
  })
  Object.defineProperty(app, 'router', {
    configurable: true,
    get: () => router,
  })

  // Dispatch
  app.handle = (req: ExpRequest, res: ExpResponse, next?: NextFunction) => {
    setPromiseErrorForwarding(compat === '5')
    const done = next ?? ((err?: unknown) => finalHandler(err, req, res, String(settings.env)))
    router.handle(req, res, done)
  }

  // Hono bridge
  hono.all('*', (c: Context) => {
    return new Promise<Response>((resolve, reject) => {
      const req = createRequest({ ctx: c, proto: app.request, compat })
      const res = createResponse({ ctx: c, proto: app.response, compat, resolve })
      req.res = res
      res.req = req
      req.next = undefined

      if (settings['x-powered-by']) res.setHeader('x-powered-by', 'Exphono')

      c.req.raw.signal?.addEventListener('abort', () => abortResponse(res), { once: true })

      try {
        app.handle(req, res)
      } catch (err) {
        reject(err)
      }
    })
  })

  Object.defineProperty(app, 'hono', { configurable: true, get: () => hono })

  app.fetch = async (request: Request, env?: unknown, ctx?: unknown) =>
    await hono.fetch(request, env, ctx as never)

  const worker = {
    fetch: (request: Request, env?: unknown, ctx?: unknown) => app.fetch(request, env, ctx),
  }
  Object.defineProperty(app, 'worker', { configurable: true, get: () => worker })

  // Implemented in runtime/serve.ts, aliased away in the edge build
  app.listen = (...args: unknown[]) => {
    const port = typeof args[0] === 'number' ? args[0] : undefined
    const hostname = typeof args[1] === 'string' ? args[1] : undefined
    const callback = args.find((a) => typeof a === 'function') as (() => void) | undefined
    return serve(app, port, hostname, callback)
  }

  return app
}

function readEnv(): string {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    return proc?.env?.NODE_ENV ?? 'development'
  } catch {
    return 'development'
  }
}

/** True when these came from a Node HTTP server rather than from exphono. */
function isNodeReqRes(req: unknown, res: unknown): boolean {
  if (typeof req !== 'object' || req === null) return false
  if (kState in (req as Record<symbol, unknown>)) return false
  return typeof (res as { writeHead?: unknown })?.writeHead === 'function'
}

/** Wires a sub-app in, swapping prototypes while it handles the request. */
function mountSubApp(
  parent: Application,
  router: RouterInstance,
  path: PathSpec,
  child: Application,
): void {
  child.mountpath = typeof path === 'string' ? path : '/'
  child.parent = parent

  router.use(path, (req: ExpRequest, res: ExpResponse, next: NextFunction) => {
    const origReq = Object.getPrototypeOf(req)
    const origRes = Object.getPrototypeOf(res)
    Object.setPrototypeOf(req, child.request)
    Object.setPrototypeOf(res, child.response)
    child.handle(req, res, (err?: unknown) => {
      Object.setPrototypeOf(req, origReq)
      Object.setPrototypeOf(res, origRes)
      next(err)
    })
  })

  child.emit('mount', parent)
}
