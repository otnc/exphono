/**
 * Express extension patterns rely on prototypes:
 *
 *   express.response.ok = fn   affects every app
 *   app.response.ok = fn       affects one app
 *   req.user = x               affects one request
 *
 * Express mutates Node's IncomingMessage with setPrototypeOf; ExpHono creates its own objects, so Object.create is enough.
 */

/** Internal state, kept off the public surface. */
export const kState = Symbol('exphono.state')

/**
 * The Fetch `Request` standard has no field for the underlying TCP peer address, so the
 * Node adapter stashes it here as it builds the `Request` and `req.socket.remoteAddress`
 * reads it back — a symbol so it can't collide with a real header or be enumerated.
 */
export const kRemoteAddress = Symbol('exphono.remoteAddress')

/**
 * The Fetch `Response` standard restricts `status` to 200-599 — Node's own http module has
 * no such limit, and Express code relies on setting arbitrary values like 101 or a made-up
 * code past 599. The real status is stashed here when it falls outside that range (the
 * `Response` itself is built with a safe placeholder) and the Node adapter substitutes it
 * back in before writing the real HTTP response line.
 */
export const kActualStatus = Symbol('exphono.actualStatus')

/**
 * A `GET`/`HEAD` Fetch `Request` cannot carry a body at all, so the Node adapter never
 * attaches one for those methods -- but a connect-style handler that reads the raw Node
 * request stream directly (`req.on('data', ...)`) still needs access to those bytes even
 * on a GET. The real Node `IncomingMessage` is stashed here regardless of method, so
 * ExpHono's `req` can forward its stream methods straight to it when present.
 */
export const kNodeStream = Symbol('exphono.nodeStream')

/**
 * Define a getter on the prototype that caches its result as an own property on first access, so derived values are computed once per request without leaking between them.
 */
export function defineLazyGetter<T extends object>(
  proto: T,
  name: string,
  compute: (this: T) => unknown,
): void {
  Object.defineProperty(proto, name, {
    configurable: true,
    enumerable: true,
    get(this: T) {
      const value = compute.call(this)
      Object.defineProperty(this, name, {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      })
      return value
    },
    set(this: T, value: unknown) {
      Object.defineProperty(this, name, {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      })
    },
  })
}

/** Drop a cached value so the getter runs again, e.g. after `req.url` is rewritten. */
export function invalidateLazy(obj: object, name: string): void {
  if (Object.hasOwn(obj, name)) {
    delete (obj as Record<string, unknown>)[name]
  }
}

/** Mirrors `app.request = Object.create(req, { app: { value: app } })` from Express. */
export function createAppProto<T extends object>(base: T, app: unknown): T {
  return Object.create(base, {
    app: { value: app, writable: false, enumerable: false, configurable: true },
  }) as T
}
