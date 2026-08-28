/**
 * Builds the `express` callable and hangs the module exports off it, the way Express does.
 *
 * The compat mode is read through a callback so the `exphono/v4` and `exphono/v5`
 * subpaths can each pin their own without sharing mutable state with the main entry.
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

export interface ExpressFactory {
  (): Application

  // Same exports as Express
  application: Record<string, unknown>
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

/** Express 4 query parser middleware; removed in v5. */
export function query(_options?: unknown): never {
  return report('EXPHONO_E008', { context: 'express.query' }) as never
}

/** Marks a function as Hono-shaped middleware. */
export const EXPHONO_HONO_MW = Symbol.for('exphono.honoMiddleware')

export function honoMiddleware<T extends (...args: never[]) => unknown>(fn: T): T {
  Object.defineProperty(fn, EXPHONO_HONO_MW, { value: true, enumerable: false })
  return fn
}

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

export interface FactoryOptions {
  getCompat: () => CompatMode
  setCompat?: (compat: CompatMode) => void
}

export function buildFactory({ getCompat, setCompat }: FactoryOptions): ExpressFactory {
  const express = (): Application => createApplication(getCompat())
  const factory = express as unknown as ExpressFactory

  const configure = (options: ExphonoOptions): void => {
    if (options.compat) setCompat?.(options.compat)
  }

  // Attached as properties, like Express, so `const { Router } = require('exphono')` works
  const attach = (name: string, value: unknown): void => {
    Object.defineProperty(factory, name, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }

  attach('application', {})
  attach('request', requestProto)
  attach('response', responseProto)
  attach('Router', createRouter)
  attach('Route', RouteClass)
  attach('json', json)
  attach('raw', raw)
  attach('text', text)
  attach('urlencoded', urlencoded)
  attach('static', serveStatic)
  attach('query', query)
  attach('configure', configure)
  attach('honoMiddleware', honoMiddleware)
  attach('detectRuntime', detectRuntime)

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

  return factory
}
