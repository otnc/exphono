/**
 * exphono — run Express code on Hono.
 *
 * The export shape follows Express: the default export is the `express` function itself,
 * helpers like `Router` and `json` are both properties of it and named exports, and the
 * CJS build sets `module.exports` to the function.
 */

import type { ExphonoOptions } from './application.js'
import { buildFactory, query } from './factory.js'
import type { CompatMode } from './inventory.js'
import { json, raw, text, urlencoded } from './middleware/body.js'
import { serveStatic } from './middleware/static.js'
import { requestProto } from './request.js'
import { responseProto } from './response.js'
import { createRouter, Route as RouteClass, type RouterInstance } from './router/index.js'

export type { Application, ExphonoOptions } from './application.js'
export { ExphonoError, ExphonoUnsupportedError } from './diagnostics.js'
export { EXPHONO_HONO_MW, honoMiddleware } from './factory.js'
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

/**
 * Express major reproduced by default.
 *
 * Import `exphono/v4` or `exphono/v5` to pin it instead; those entries carry their own
 * setting rather than sharing this one.
 */
let defaultCompat: CompatMode = '5'

export function setDefaultCompat(compat: CompatMode): void {
  defaultCompat = compat
}

export function configure(options: ExphonoOptions): void {
  if (options.compat) defaultCompat = options.compat
}

const factory = buildFactory({
  getCompat: () => defaultCompat,
  setCompat: (compat) => {
    defaultCompat = compat
  },
})

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
