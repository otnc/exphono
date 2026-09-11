/**
 * Express's layer stack.
 *
 * Rather than dispatching to one matched handler, layers are walked in order and driven by `next()`. Mount rewrites of `req.url`, `next('route')`, `next('router')` and the error-only walk are all reproduced.
 *
 * Internal names such as `handle_request` and `_options` are kept, since some code calls them directly.
 */

import { type CompatMode, HTTP_METHODS, type HttpMethod } from '../inventory.js'
import { type ExpRequest, setRequestUrl } from '../request.js'
import type { ExpResponse } from '../response.js'
import { describeType } from '../utils/type-name.js'
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

  /** Set when the path matched but a parameter could not be decoded. */
  malformed?: unknown

  match(path: string): boolean {
    this.malformed = undefined
    let result: ReturnType<PathMatcher['match']>
    try {
      result = this.matcher.match(path)
    } catch (err) {
      this.malformed = err
      return true
    }
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
      // A falsy rejection (Promise.reject() with no value, say) would otherwise pass next() a value indistinguishable from "no error", silently skipping every error handler downstream instead of reaching one.
      if (forwardPromiseErrors) next(err || new Error('Rejected promise'))
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
  /**
   * Express 4's own `Route` and the `router` package Express 5 uses word a bad-handler
   * TypeError differently (v4: "Route.get() requires a callback function but got a
   * Number"; v5: the plain "argument handler must be a function"). Real Express ships two
   * separate implementations; exphono shares one `Route` class across both compat modes,
   * so it needs to know which wording to use. Defaults to '5' so `new Route(path)`
   * constructed directly (no router involved) matches Express 5, same as the class itself.
   */
  compat: CompatMode

  constructor(path: string, compat: CompatMode = '5') {
    this.path = path
    this.compat = compat
  }

  /**
   * Express 4 names these `_handles_method` / `_options`; the router package used by Express 5 names them `_handlesMethod` / `_methods`. Both are provided.
   */
  _handles_method(method: string): boolean {
    if (this.methods._all) return true
    if (!method) return false
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

  all(...handlers: unknown[]): this {
    for (const h of handlers.flat(Number.POSITIVE_INFINITY)) {
      if (typeof h !== 'function') {
        throw new TypeError(
          this.compat === '4'
            ? `Route.all() requires a callback function but got a ${Object.prototype.toString.call(h)}`
            : 'argument handler must be a function',
        )
      }
      this.stack.push(new Layer('/', h as RequestHandler, { isMount: false, matcher: MATCH_ALL }))
    }
    this.methods._all = true
    return this
  }

  dispatch(req: ExpRequest, res: ExpResponse, done: NextFunction): void {
    if (this.stack.length === 0) {
      done()
      return
    }

    const method = (req.method ?? '').toLowerCase()
    req.route = this

    let idx = 0
    let sync = 0
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

      // Same guard as Router.handle: a long chain of synchronous handlers recurses straight into the next layer on every next() call, so without this a large enough stack of handlers blows the call stack. See the matching comment there.
      if (++sync > 100) {
        setTimeout(() => next(err), 0)
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
      // Reached once the handler above and everything it called synchronously has returned, unwinding one frame at a time back through every enclosing next().
      sync = 0
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
    value(this: Route, ...handlers: unknown[]) {
      for (const h of handlers.flat(Number.POSITIVE_INFINITY)) {
        if (typeof h !== 'function') {
          throw new TypeError(
            this.compat === '4'
              ? `Route.${verb}() requires a callback function but got a ${Object.prototype.toString.call(h)}`
              : 'argument handler must be a function',
          )
        }
        const layer = new Layer('/', h as RequestHandler, {
          isMount: false,
          matcher: MATCH_ALL,
        }) as Layer & { method?: string }
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
      // A mount (used by app.use()) always matches loosely regardless of strict routing — Express's own router hardcodes strict: false for it, only ever consulting the setting for a route's own, fully-anchored match.
      strict: end ? opts.strict : false,
      compat: opts.compat,
    })

  router.use = (...args: unknown[]) => {
    const { path, handlers } = splitPathAndHandlers(args)
    if (handlers.length === 0) {
      throw new TypeError(
        opts.compat === '4'
          ? 'Router.use() requires a middleware function'
          : 'argument handler is required',
      )
    }
    for (const h of handlers) {
      if (typeof h !== 'function') {
        throw new TypeError(
          opts.compat === '4'
            ? `Router.use() requires a middleware function but got a ${describeType(h)}`
            : 'argument handler must be a function',
        )
      }
      router.stack.push(
        new Layer(path, h as Handler, { isMount: true, matcher: matcherFor(path, false) }),
      )
    }
    return router
  }

  router.route = (path: string) => {
    const route = new Route(path, opts.compat)
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
    if (fn === undefined) throw new TypeError('argument fn is required')
    if (typeof fn !== 'function') throw new TypeError('argument fn must be a function')
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
    let slashAdded = false
    let sync = 0
    const protohost = getProtohost(req.url ?? '') ?? ''
    const paramCalled: Record<string, ParamCalled> = {}
    const parentUrl = req.baseUrl
    const parentParams = req.params
    req.originalUrl = req.originalUrl || req.url
    // Collects every method a route along the way declares but this OPTIONS request didn't match, so a request nothing else handles can still get a default response.
    const optionsMethods: string[] | undefined = req.method === 'OPTIONS' ? [] : undefined

    // A router must leave req.url, baseUrl and params exactly as it found them
    const restore = (): void => {
      req.params = parentParams
      if (slashAdded) {
        setRequestUrl(req, req.url.slice(1))
        slashAdded = false
      }
      if (removed.length === 0) return
      req.baseUrl = parentUrl
      setRequestUrl(req, protohost + removed + req.url.slice(protohost.length))
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

      // A pathologically long chain of synchronous handlers would otherwise blow the call stack, since each next() call recurses straight into the layer it found. This only guards that chain — the scan below for the next matching layer runs in a plain loop within a single call, so skipping past many non-matching layers never grows the stack and never needs to trip this. A microtask would starve the event loop instead of yielding to it (this chain would requeue itself forever and never let a macrotask like a test's own timeout run), so this schedules a real macrotask.
      if (++sync > 100) {
        setTimeout(() => next(err), 0)
        return
      }

      const path = getPathname(req.url)
      if (path == null) {
        req.params = parentParams
        done(err)
        return
      }

      // Scan forward for a layer that matches the path, handles the method in play, and is the right kind (error handler vs. not) for whether an error is in flight.
      let layer: Layer | undefined
      let layerErr = err
      while (idx < router.stack.length) {
        const candidate = router.stack[idx++] as Layer
        if (!candidate.match(path)) continue
        if (candidate.malformed) {
          layerErr = candidate.malformed
          continue
        }
        if (candidate.route && !candidate.route._handles_method(req.method)) {
          optionsMethods?.push(...candidate.route._options())
          continue
        }
        if (Boolean(layerErr) !== candidate.isErrorHandler) continue
        layer = candidate
        break
      }

      if (!layer) {
        req.params = parentParams
        if (!layerErr && optionsMethods && optionsMethods.length > 0) {
          sendOptionsResponse(res, optionsMethods, (err) => done(err))
          return
        }
        done(layerErr)
        return
      }

      // Express exposes the current next() on the request; res.format and friends use it
      req.next = next
      req.params = opts.mergeParams ? mergeParams(layer.params, parentParams) : layer.params

      const matchedLayer = layer
      const dispatchErr = layerErr
      // Captured now rather than read from the layer inside proceed(): a param callback can complete asynchronously (e.g. via setTimeout), and in the meantime a second, concurrent request can run this same shared Layer instance's match() again, overwriting matchedPath before this request's proceed() gets to it.
      const matchedPath = layer.matchedPath
      const proceed = (): void => {
        if (matchedLayer.isMount && matchedPath && matchedPath !== '/') {
          // Strip the matched prefix before delegating
          removed = matchedPath.replace(/\/$/, '')
          req.baseUrl = parentUrl + removed
          const rest = req.url.slice(protohost.length + removed.length)
          if (!protohost && rest[0] !== '/') {
            setRequestUrl(req, `${protohost}/${rest}`)
            slashAdded = true
          } else {
            setRequestUrl(req, protohost + rest)
          }
        }
        if (dispatchErr) matchedLayer.handle_error(dispatchErr, req, res, next)
        else matchedLayer.handle_request(req, res, next)
        // Reached only once the handler above — and everything it called synchronously, including any nested next() calls — has fully returned. On a deep synchronous chain that unwinds one frame at a time, back through every enclosing proceed(), resetting sync here in each of them by the time the deferred continuation from the `sync > 100` branch actually runs.
        sync = 0
      }

      processParams(router, matchedLayer, paramCalled, req, res, proceed, next)
    }

    next()
  }

  return router
}

/**
 * The default `OPTIONS` reply when nothing else handled the request: an `Allow` header listing every method a route along the way declared. Errors thrown while writing it (headers already sent by earlier middleware, say) are reported like any other error rather than crashing.
 */
function sendOptionsResponse(res: ExpResponse, methods: string[], next: NextFunction): void {
  try {
    const allow = Array.from(new Set(methods)).sort().join(', ')
    res.set('allow', allow)
    res.set('content-length', String(allow.length))
    res.set('content-type', 'text/plain')
    res.set('x-content-type-options', 'nosniff')
    res.end(allow)
  } catch (err) {
    next(err)
  }
}

/** `undefined` for a missing or blank URL, matching `parseUrl(req).pathname` returning `null`. */
function getPathname(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url, 'http://exphono.invalid').pathname
  } catch {
    return undefined
  }
}

/**
 * The literal `scheme://host` prefix of a full URL sent as the request-target — real, if unusual, since HTTP allows it. Mount trimming rewrites `req.url` from the pathname onward and needs this preserved verbatim rather than reparsed.
 */
function getProtohost(url: string): string | undefined {
  if (url.length === 0 || url[0] === '/') return undefined
  const searchIndex = url.indexOf('?')
  const pathLength = searchIndex === -1 ? url.length : searchIndex
  const fqdnIndex = url.slice(0, pathLength).indexOf('://')
  if (fqdnIndex === -1) return undefined
  const slashIndex = url.indexOf('/', fqdnIndex + 3)
  return slashIndex === -1 ? url.slice(0, pathLength) : url.slice(0, slashIndex)
}

interface ParamCalled {
  error: unknown
  match: string
  value: string
}

/**
 * Runs the `app.param()` callbacks for this layer's parameters.
 *
 * `called` is shared across the whole `router.handle()` call: a parameter matched by more than one layer (e.g. the same `:id` on both a param-matching middleware and the route itself) only runs its callbacks once per request, as long as the value hasn't changed.
 */
function processParams(
  router: RouterInstance,
  layer: Layer,
  called: Record<string, ParamCalled>,
  req: ExpRequest,
  res: ExpResponse,
  done: () => void,
  onError: NextFunction,
): void {
  const names = Object.keys(layer.params)

  let i = 0
  const param = (err?: unknown): void => {
    if (err) {
      onError(err)
      return
    }

    const name = names[i++]
    if (name === undefined) {
      done()
      return
    }

    const value = layer.params[name] as string
    const callbacks = router.params[name]
    if (value === undefined || !callbacks || callbacks.length === 0) {
      param()
      return
    }

    const prior = called[name]
    if (
      prior &&
      (prior.match === value || (prior.error !== undefined && prior.error !== ROUTE_SIGNAL))
    ) {
      req.params[name] = prior.value
      param(prior.error)
      return
    }

    const record: ParamCalled = { error: undefined, match: value, value }
    called[name] = record

    let j = 0
    const runCallback = (err2?: unknown): void => {
      record.value = req.params[name] as string
      if (err2) {
        record.error = err2
        onError(err2)
        return
      }
      const fn = callbacks[j++]
      if (!fn) {
        param()
        return
      }
      try {
        fn(req, res, runCallback, value, name)
      } catch (e) {
        record.error = e
        onError(e)
      }
    }
    runCallback()
  }

  param()
}

/**
 * Splits `use(...)` arguments into a path and handlers.
 *
 * Express decides whether the first argument is a path by peeling arrays until it finds a non-array: if that is not a function, the argument was a path. Handlers are then flattened to any depth.
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

/**
 * Merges a layer's params over the parent router's, as the router package does.
 *
 * Numeric keys come from unnamed regexp captures and have to keep their order across the boundary, so the child's indices are shifted past the parent's rather than overwriting.
 */
function mergeParams(
  params: Record<string, string>,
  parent: Record<string, string> | undefined,
): Record<string, string> {
  if (!parent || typeof parent !== 'object') return params

  const out: Record<string, string> = { ...parent }
  if (!(0 in params) || !(0 in parent)) return Object.assign(out, params)

  let childCount = 0
  while (childCount in params) childCount++
  let parentCount = 0
  while (parentCount in parent) parentCount++

  const shifted: Record<string, string> = { ...params }
  for (let i = childCount - 1; i >= 0; i--) {
    shifted[i + parentCount] = params[i] as string
    if (i < parentCount) delete shifted[i]
  }

  return Object.assign(out, shifted)
}
