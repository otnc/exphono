/**
 * exphono — run Express code on Hono.
 *
 * The export shape follows Express: the default export is the `express` function itself,
 * helpers like `Router` and `json` are both properties of it and named exports, and the
 * CJS build sets `module.exports` to the function.
 */

import { type Application, createApplication, type ExphonoOptions } from './application.js'
import { report } from './diagnostics.js'
import type { CompatMode } from './inventory.js'
import { json, raw, text, urlencoded } from './middleware/body.js'
import { serveStatic } from './middleware/static.js'
import { type ExpRequest, requestProto } from './request.js'
import { type ExpResponse, responseProto } from './response.js'
import type { RouterOptions } from './router/index.js'
import { createRouter, Route as RouteClass, type RouterInstance } from './router/index.js'
import { detectRuntime } from './runtime/detect.js'

export type { Application, ExphonoOptions } from './application.js'
export { ExphonoError, ExphonoUnsupportedError } from './diagnostics.js'
export type { CompatMode, CoverageClass } from './inventory.js'
export type { ExpRequest as Request } from './request.js'
export type { ExpResponse as Response } from './response.js'
export type {
  ErrorRequestHandler,
  NextFunction,
  RequestHandler,
  RouterInstance,
  RouterOptions,
} from './router/index.js'
export type { Runtime } from './runtime/detect.js'
export { detectRuntime } from './runtime/detect.js'

/** Express major reproduced by default. */
let defaultCompat: CompatMode = '5'

/** Used by the `exphono/v4` and `exphono/v5` subpaths. */
export function setDefaultCompat(compat: CompatMode): void {
  defaultCompat = compat
}

interface ExpressFactory {
  (): Application

  // Same exports as Express
  application: ExpRequest extends never ? never : Record<string, unknown>
  request: ExpRequest
  response: ExpResponse
  Router: (options?: RouterOptions) => RouterInstance
  Route: typeof RouteClass
  json: typeof json
  raw: typeof raw
  text: typeof text
  urlencoded: typeof urlencoded
  static: typeof serveStatic
  query: (options?: unknown) => never

  // exphono additions
  configure: (options: ExphonoOptions) => void
  honoMiddleware: typeof honoMiddleware
  detectRuntime: typeof detectRuntime
}

function express(): Application {
  return createApplication(defaultCompat)
}

/** Express 4 query parser middleware; removed in v5. */
function query(_options?: unknown): never {
  return report('EXPHONO_E008', { context: 'express.query' }) as never
}

/** Marks a function as Hono-shaped middleware. */
export const EXPHONO_HONO_MW = Symbol.for('exphono.honoMiddleware')

export function honoMiddleware<T extends (...args: never[]) => unknown>(fn: T): T {
  Object.defineProperty(fn, EXPHONO_HONO_MW, { value: true, enumerable: false })
  return fn
}

export function configure(options: ExphonoOptions): void {
  if (options.compat) defaultCompat = options.compat
}

const factory = express as unknown as ExpressFactory

// Attached as properties, like Express, so `const { Router } = require('exphono')` works
Object.defineProperties(factory, {
  application: { value: {}, writable: true, enumerable: true, configurable: true },
  request: { value: requestProto, writable: true, enumerable: true, configurable: true },
  response: { value: responseProto, writable: true, enumerable: true, configurable: true },
  Router: { value: createRouter, writable: true, enumerable: true, configurable: true },
  Route: { value: RouteClass, writable: true, enumerable: true, configurable: true },
  json: { value: json, writable: true, enumerable: true, configurable: true },
  raw: { value: raw, writable: true, enumerable: true, configurable: true },
  text: { value: text, writable: true, enumerable: true, configurable: true },
  urlencoded: { value: urlencoded, writable: true, enumerable: true, configurable: true },
  static: { value: serveStatic, writable: true, enumerable: true, configurable: true },
  query: { value: query, writable: true, enumerable: true, configurable: true },
  configure: { value: configure, writable: true, enumerable: true, configurable: true },
  honoMiddleware: { value: honoMiddleware, writable: true, enumerable: true, configurable: true },
  detectRuntime: { value: detectRuntime, writable: true, enumerable: true, configurable: true },
})

/**
 * Connect-era middleware placeholders from Express 4. They exist only to throw a
 * message pointing at the separate package, and are reproduced with the same wording.
 */
const CONNECT_MIDDLEWARE = [
  'bodyParser',
  'compress',
  'cookieParser',
  'cookieSession',
  'csrf',
  'directory',
  'errorHandler',
  'favicon',
  'limit',
  'logger',
  'methodOverride',
  'multipart',
  'responseTime',
  'session',
  'staticCache',
  'timeout',
  'vhost',
] as const

for (const name of CONNECT_MIDDLEWARE) {
  Object.defineProperty(factory, name, {
    configurable: true,
    enumerable: false,
    get() {
      throw new Error(
        `Most middleware (like ${name}) is no longer bundled with Express and must be installed separately.`,
      )
    },
  })
}

export default factory

/**
 * `Router` is used as both a value and a type; a const and a type can share a name.
 */
const Router = createRouter
type Router = RouterInstance

// `static` is a reserved word, so it is only exportable via `as`
export {
  json,
  query,
  RouteClass as Route,
  Router,
  raw,
  requestProto as request,
  responseProto as response,
  serveStatic as static,
  text,
  urlencoded,
}
