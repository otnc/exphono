/**
 * Express extension patterns rely on prototypes:
 *
 *   express.response.ok = fn   affects every app
 *   app.response.ok = fn       affects one app
 *   req.user = x               affects one request
 *
 * Express mutates Node's IncomingMessage with setPrototypeOf; exphono creates its own
 * objects, so Object.create is enough.
 */

/** Internal state, kept off the public surface. */
export const kState = Symbol('exphono.state')

/**
 * Define a getter on the prototype that caches its result as an own property on first
 * access, so derived values are computed once per request without leaking between them.
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
