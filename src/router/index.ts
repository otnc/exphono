/**
 * Express's layer stack.
 *
 * Rather than dispatching to one matched handler, layers are walked in order and driven
 * by `next()`. Mount rewrites of `req.url`, `next('route')`, `next('router')` and the
 * error-only walk are all reproduced.
 *
 * Internal names such as `handle_request` and `_options` are kept, since some code
 * calls them directly.
 */

import { type CompatMode, HTTP_METHODS, type HttpMethod } from '../inventory.js'
import { type ExpRequest, setRequestUrl } from '../request.js'
import type { ExpResponse } from '../response.js'
import { compilePath, MATCH_ALL, type PathMatcher, type PathSpec } from './matcher.js'

export type NextFunction = (err?: unknown) => void
export type RequestHandler = (req: ExpRequest, res: ExpResponse, next: NextFunction) => unknown
export type ErrorRequestHandler = (
  err: unknown,
  req: ExpRequest,
  res: ExpResponse,
  next: NextFunction,
) => unknown
export type Handler = RequestHandler | ErrorRequestHandler

export interface RouterOptions {
  caseSensitive?: boolean
  mergeParams?: boolean
  strict?: boolean
  /** Internal: passes the compat mode to the matcher. */
  compat?: CompatMode
}

const ROUTE_SIGNAL = 'route'
const ROUTER_SIGNAL = 'router'

// ─────────────────────────────────────────────────────────────────────────────
// Layer
// ─────────────────────────────────────────────────────────────────────────────

export class Layer {
  path: PathSpec
  matcher: PathMatcher
  handle: Handler
  /** Four parameters means an error handler. */
  readonly isErrorHandler: boolean
  /** Registered via `use`: matches a prefix and rewrites `req.url`. */
  readonly isMount: boolean
  route?: Route
  params: Record<string, string> = {}
  matchedPath = ''

  constructor(path: PathSpec, handle: Handler, opts: { isMount: boolean; matcher: PathMatcher }) {
    this.path = path
    this.handle = handle
    this.matcher = opts.matcher
    this.isMount = opts.isMount
    this.isErrorHandler = handle.length === 4
  }

  match(path: string): boolean {
    const result = this.matcher.match(path)
    if (!result) {
      this.params = {}
      this.matchedPath = ''
      return false
    }
    this.params = result.params
    this.matchedPath = result.matched
    return true
  }

  handle_request(req: ExpRequest, res: ExpResponse, next: NextFunction): void {
    if (this.isErrorHandler) {
      next()
      return
    }
    try {
      const out = (this.handle as RequestHandler)(req, res, next)
      settle(out, next)
    } catch (err) {
      next(err)
    }
  }

  handle_error(err: unknown, req: ExpRequest, res: ExpResponse, next: NextFunction): void {
    if (!this.isErrorHandler) {
      next(err)
      return
    }
    try {
      const out = (this.handle as ErrorRequestHandler)(err, req, res, next)
      settle(out, next)
    } catch (e) {
      next(e)
    }
  }
}

/**
 * Express 5 forwards a rejected handler promise to `next(err)`; Express 4 ignores it.
 */
let forwardPromiseErrors = true

export function setPromiseErrorForwarding(enabled: boolean): void {
  forwardPromiseErrors = enabled
}

function settle(out: unknown, next: NextFunction): void {
  if (out && typeof (out as Promise<unknown>).then === 'function') {
    ;(out as Promise<unknown>).then(undefined, (err: unknown) => {
      if (forwardPromiseErrors) next(err)
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Route
// ─────────────────────────────────────────────────────────────────────────────

export class Route {
  path: string
  stack: Layer[] = []
  methods: Record<string, boolean> = {}

  constructor(path: string) {
    this.path = path
  }

  /**
   * Express 4 names these `_handles_method` / `_options`; the router package used by
   * Express 5 names them `_handlesMethod` / `_methods`. Both are provided.
   */
  _handles_method(method: string): boolean {
    if (this.methods._all) return true
    const m = method.toLowerCase()
    return this.methods[m === 'head' && !this.methods.head ? 'get' : m] === true
  }

  _handlesMethod(method: string): boolean {
    return this._handles_method(method)
  }

  _options(): string[] {
    const list = Object.keys(this.methods)
      .filter((m) => m !== '_all')
      .map((m) => m.toUpperCase())
    if (list.includes('GET') && !list.includes('HEAD')) list.push('HEAD')
    return list
  }

  _methods(): string[] {
    return this._options()
  }

  all(...handlers: RequestHandler[]): this {
    for (const h of handlers) {
      const layer = new Layer('/', h, { isMount: false, matcher: MATCH_ALL })
      this.stack.push(layer)
    }
    this.methods._all = true
    return this
  }

  dispatch(req: ExpRequest, res: ExpResponse, done: NextFunction): void {
    if (this.stack.length === 0) {
      done()
      return
    }

    const method = req.method.toLowerCase()
    req.route = this

    let idx = 0
    const next = (err?: unknown): void => {
      // next('route') skips the rest of this route
      if (err === ROUTE_SIGNAL) {
        done()
        return
      }
      if (err === ROUTER_SIGNAL) {
        done(err)
        return
      }

      const layer = this.stack[idx++]
      if (!layer) {
        done(err)
        return
      }

      const layerMethod = (layer as Layer & { method?: string }).method
      if (layerMethod && layerMethod !== method && !(method === 'head' && layerMethod === 'get')) {
        next(err)
        return
      }

      if (err) layer.handle_error(err, req, res, next)
      else layer.handle_request(req, res, next)
    }

    next()
  }
}

// Verb methods on Route
for (const verb of HTTP_METHODS) {
  Object.defineProperty(Route.prototype, verb, {
    writable: true,
    configurable: true,
    enumerable: false,
    value(this: Route, ...handlers: RequestHandler[]) {
      for (const h of handlers) {
        const layer = new Layer('/', h, { isMount: false, matcher: MATCH_ALL }) as Layer & {
          method?: string
        }
        layer.method = verb
        this.stack.push(layer)
      }
      this.methods[verb] = true
      return this
    },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────────────────────────────────

export type ParamCallback = (
  req: ExpRequest,
  res: ExpResponse,
  next: NextFunction,
  value: string,
  name: string,
) => unknown

/** Route registration per HTTP verb. */
export type RouterVerbMethods = {
  [K in HttpMethod]: (path: PathSpec, ...handlers: RequestHandler[]) => RouterInstance
}

export interface RouterInstance extends RequestHandler, RouterVerbMethods {
  stack: Layer[]
  params: Record<string, ParamCallback[]>
  caseSensitive: boolean
  mergeParams: boolean
  strict: boolean
  use(handler: RequestHandler): RouterInstance
  use(handler: ErrorRequestHandler): RouterInstance
  use(path: PathSpec, handler: RequestHandler): RouterInstance
  use(path: PathSpec, handler: ErrorRequestHandler): RouterInstance
  use(...args: unknown[]): RouterInstance
  route(path: string): Route
  param(name: string, fn: ParamCallback): RouterInstance
  handle(req: ExpRequest, res: ExpResponse, done: NextFunction): void
  all(path: PathSpec, ...handlers: RequestHandler[]): RouterInstance
}

export function createRouter(options: RouterOptions = {}): RouterInstance {
  const opts = {
    caseSensitive: options.caseSensitive ?? false,
    strict: options.strict ?? false,
    mergeParams: options.mergeParams ?? false,
    compat: options.compat ?? '5',
  }

  const router: RouterInstance = ((req: ExpRequest, res: ExpResponse, next: NextFunction): void => {
    router.handle(req, res, next)
  }) as RouterInstance

  router.stack = []
  router.params = {}

  // express 5 exposes these as instance properties
  Object.defineProperties(router, {
    caseSensitive: { value: opts.caseSensitive, writable: true, enumerable: false },
    mergeParams: { value: opts.mergeParams, writable: true, enumerable: false },
    strict: { value: opts.strict, writable: true, enumerable: false },
  })

  const matcherFor = (path: PathSpec, end: boolean): PathMatcher =>
    compilePath(path, {
      end,
      caseSensitive: opts.caseSensitive,
      strict: opts.strict,
      compat: opts.compat,
    })

  router.use = (...args: unknown[]) => {
    const { path, handlers } = splitPathAndHandlers(args)
    if (handlers.length === 0) throw new TypeError('argument handler is required')
    for (const h of handlers) {
      if (typeof h !== 'function') throw new TypeError('argument handler must be a function')
      router.stack.push(
        new Layer(path, h as Handler, { isMount: true, matcher: matcherFor(path, false) }),
      )
    }
    return router
  }

  router.route = (path: string) => {
    const route = new Route(path)
    const dispatch: RequestHandler = (req, res, next) => {
      route.dispatch(req, res, next)
    }
    const layer = new Layer(path, dispatch, {
      isMount: false,
      matcher: matcherFor(path, true),
    })
    layer.route = route
    router.stack.push(layer)
    return route
  }

  router.param = (name: string, fn: ParamCallback) => {
    const bucket = router.params[name] ?? []
    bucket.push(fn)
    router.params[name] = bucket
    return router
  }

  router.all = (path: PathSpec, ...handlers: RequestHandler[]) => {
    const route = router.route(path as string)
    route.all(...handlers)
    return router
  }

  for (const verb of HTTP_METHODS) {
    Object.defineProperty(router, verb, {
      writable: true,
      configurable: true,
      enumerable: false,
      value(path: PathSpec, ...handlers: RequestHandler[]) {
        const route = router.route(path as string)
        ;(route as unknown as Record<string, (...h: RequestHandler[]) => Route>)[verb](...handlers)
        return router
      },
    })
  }

  router.handle = (req: ExpRequest, res: ExpResponse, done: NextFunction) => {
    let idx = 0
    let removed = ''
    const parentUrl = req.baseUrl
    const parentParams = req.params

    const restore = (): void => {
      if (removed.length === 0) return
      req.baseUrl = parentUrl
      setRequestUrl(req, removed + req.url)
      removed = ''
    }

    const next = (err?: unknown): void => {
      if (err === ROUTE_SIGNAL) {
        // A route-level signal that reached here just advances the stack
        next()
        return
      }
      if (err === ROUTER_SIGNAL) {
        restore()
        done()
        return
      }

      restore()

      const layer = router.stack[idx++]
      if (!layer) {
        req.params = parentParams
        done(err)
        return
      }

      const path = getPathname(req.url)
      if (!layer.match(path)) {
        next(err)
        return
      }

      // Skip routes that do not handle this method
      if (layer.route && !layer.route._handles_method(req.method)) {
        next(err)
        return
      }

      // While an error is in flight only error handlers run, and vice versa
      if (Boolean(err) !== layer.isErrorHandler) {
        next(err)
        return
      }

      req.params = opts.mergeParams
        ? { ...parentParams, ...layer.params }
        : { ...parentParams, ...layer.params }

      const proceed = (): void => {
        if (layer.isMount && layer.matchedPath && layer.matchedPath !== '/') {
          // Strip the matched prefix before delegating
          removed = layer.matchedPath.replace(/\/$/, '')
          req.baseUrl = parentUrl + removed
          setRequestUrl(req, req.url.slice(removed.length) || '/')
        }
        if (err) layer.handle_error(err, req, res, next)
        else layer.handle_request(req, res, next)
      }

      processParams(router, layer, req, res, proceed, next)
    }

    next()
  }

  return router
}

function getPathname(url: string): string {
  const q = url.indexOf('?')
  return q === -1 ? url : url.slice(0, q)
}

/** Runs the `app.param()` callbacks for this layer's parameters. */
function processParams(
  router: RouterInstance,
  layer: Layer,
  req: ExpRequest,
  res: ExpResponse,
  done: () => void,
  onError: NextFunction,
): void {
  const names = Object.keys(layer.params)
  if (names.length === 0) {
    done()
    return
  }

  const pending: [string, ParamCallback][] = []
  for (const name of names) {
    for (const fn of router.params[name] ?? []) pending.push([name, fn])
  }
  if (pending.length === 0) {
    done()
    return
  }

  let i = 0
  const step = (err?: unknown): void => {
    if (err) {
      onError(err)
      return
    }
    const entry = pending[i++]
    if (!entry) {
      done()
      return
    }
    const [name, fn] = entry
    try {
      fn(req, res, step, layer.params[name] as string, name)
    } catch (e) {
      onError(e)
    }
  }
  step()
}

/**
 * Splits `use(...)` arguments into a path and handlers.
 *
 * Express decides whether the first argument is a path by peeling arrays until it finds
 * a non-array: if that is not a function, the argument was a path. Handlers are then
 * flattened to any depth.
 */
export function splitPathAndHandlers(args: unknown[]): { path: PathSpec; handlers: unknown[] } {
  let path: PathSpec = '/'
  let offset = 0

  const first = args[0]
  if (typeof first !== 'function') {
    let probe: unknown = first
    while (Array.isArray(probe) && probe.length !== 0) probe = probe[0]
    if (typeof probe !== 'function') {
      offset = 1
      path = first as PathSpec
    }
  }

  return { path, handlers: args.slice(offset).flat(Number.POSITIVE_INFINITY) }
}
