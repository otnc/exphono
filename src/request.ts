/**
 * Express's `req` on top of a Fetch Request.
 *
 * Created with `Object.create(app.request)`; derived values are lazy getters on the
 * prototype that cache onto the instance.
 */

import type { Context } from 'hono'
import { report } from './diagnostics.js'
import type { CompatMode } from './inventory.js'
import { parseUrlencoded } from './middleware/body.js'
import { defineLazyGetter, invalidateLazy, kState } from './object-model.js'
import { accepts, acceptsSimple, isFresh, isType, parseRange } from './utils/negotiation.js'

export interface FakeSocket {
  remoteAddress: string | undefined
  remotePort: number | undefined
  encrypted: boolean
  destroyed: boolean
  readable: boolean
  writable: boolean
  setTimeout(): FakeSocket
  end(): FakeSocket
  destroy(): FakeSocket
  unref(): FakeSocket
  ref(): FakeSocket
}

interface RequestState {
  ctx: Context
  compat: CompatMode
  /** Parsed request URL. */
  parsed: URL
}

export interface ExpRequest {
  app: unknown
  method: string
  url: string
  originalUrl: string
  baseUrl: string
  params: Record<string, string>
  body: unknown
  cookies: Record<string, string>
  signedCookies: Record<string, string>
  res?: unknown
  next?: (err?: unknown) => void
  route?: unknown

  // exphono additions
  readonly hono: Context
  readonly raw: globalThis.Request
  readonly env: unknown

  readonly path: string
  readonly query: Record<string, unknown>
  readonly headers: Record<string, string | string[] | undefined>
  readonly rawHeaders: string[]
  readonly protocol: string
  readonly secure: boolean
  readonly host: string
  readonly hostname: string
  readonly subdomains: string[]
  readonly ip: string | undefined
  readonly ips: string[]
  readonly xhr: boolean
  readonly fresh: boolean
  readonly stale: boolean

  readonly socket: FakeSocket
  readonly connection: FakeSocket
  readonly httpVersion: string
  readonly httpVersionMajor: number
  readonly httpVersionMinor: number
  complete: boolean

  get(name: string): string | string[] | undefined
  header(name: string): string | string[] | undefined
  is(type: string | string[]): string | false | null
  accepts(...types: string[]): string | string[] | false
  acceptsCharsets(...charsets: string[]): string | string[] | false
  acceptsEncodings(...encodings: string[]): string | string[] | false
  acceptsLanguages(...langs: string[]): string | string[] | false

  [kState]: RequestState
}

/** Exported as `express.request`. */
export const requestProto = {} as ExpRequest

// ─────────────────────────────────────────────────────────────────────────────
// Methods
// ─────────────────────────────────────────────────────────────────────────────

function headerOf(req: ExpRequest, name: string): string | string[] | undefined {
  const lower = String(name).toLowerCase()
  const headers = req[kState].ctx.req.raw.headers
  if (lower === 'referer' || lower === 'referrer') {
    return headers.get('referer') ?? headers.get('referrer') ?? undefined
  }
  if (lower === 'set-cookie') {
    const all = headers.getSetCookie?.() ?? []
    return all.length > 0 ? all : undefined
  }
  return headers.get(lower) ?? undefined
}

function str(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

const protoMethods: Record<string, (this: ExpRequest, ...args: never[]) => unknown> = {
  get(this: ExpRequest, name: string) {
    if (!name) throw new TypeError('name argument is required to req.get')
    if (typeof name !== 'string') throw new TypeError('name must be a string to req.get')
    return headerOf(this, name)
  },

  header(this: ExpRequest, name: string) {
    return this.get(name)
  },

  accepts(this: ExpRequest, ...types: (string | string[])[]) {
    return accepts(str(headerOf(this, 'accept')), types.flat())
  },

  acceptsCharsets(this: ExpRequest, ...charsets: (string | string[])[]) {
    return acceptsSimple(str(headerOf(this, 'accept-charset')), charsets.flat(), undefined)
  },

  acceptsEncodings(this: ExpRequest, ...encodings: (string | string[])[]) {
    // identity is acceptable unless explicitly refused
    return acceptsSimple(str(headerOf(this, 'accept-encoding')), encodings.flat(), 'identity')
  },

  acceptsLanguages(this: ExpRequest, ...langs: (string | string[])[]) {
    return acceptsSimple(str(headerOf(this, 'accept-language')), langs.flat(), undefined)
  },

  is(this: ExpRequest, ...types: (string | string[])[]) {
    return isType(str(headerOf(this, 'content-type')), types.flat())
  },

  range(this: ExpRequest, size: number, options?: { combine?: boolean }) {
    return parseRange(size, str(headerOf(this, 'range')), options)
  },

  // Removed in Express 5, kept so the surface stays complete

  param(this: ExpRequest, name: string, defaultValue?: unknown) {
    deprecatedInV5(this, 'req.param')
    const params = this.params as Record<string, unknown>
    if (params?.[name] != null) return params[name]
    const body = this.body as Record<string, unknown> | undefined
    if (body?.[name] != null) return body[name]
    const query = this.query as Record<string, unknown> | undefined
    if (query?.[name] != null) return query[name]
    return defaultValue
  },

  acceptsCharset(this: ExpRequest, ...charsets: (string | string[])[]) {
    deprecatedInV5(this, 'req.acceptsCharset')
    return this.acceptsCharsets(...(charsets.flat() as string[]))
  },

  acceptsEncoding(this: ExpRequest, ...encodings: (string | string[])[]) {
    deprecatedInV5(this, 'req.acceptsEncoding')
    return this.acceptsEncodings(...(encodings.flat() as string[]))
  },

  acceptsLanguage(this: ExpRequest, ...langs: (string | string[])[]) {
    deprecatedInV5(this, 'req.acceptsLanguage')
    return this.acceptsLanguages(...(langs.flat() as string[]))
  },
}

/** Reports a v4-only API being used under compat=5. */
function deprecatedInV5(req: ExpRequest, context: string): void {
  if (req[kState].compat !== '4') report('EXPHONO_E008', { context })
}

for (const [name, value] of Object.entries(protoMethods)) {
  Object.defineProperty(requestProto, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Lazy getters
// ─────────────────────────────────────────────────────────────────────────────

defineLazyGetter(requestProto, 'path', function (this: ExpRequest) {
  const q = this.url.indexOf('?')
  return q === -1 ? this.url : this.url.slice(0, q)
})

defineLazyGetter(requestProto, 'headers', function (this: ExpRequest) {
  const out: Record<string, string | string[] | undefined> = {}
  const raw = this[kState].ctx.req.raw.headers
  raw.forEach((value, key) => {
    out[key] = value
  })
  const setCookie = raw.getSetCookie?.() ?? []
  if (setCookie.length > 0) out['set-cookie'] = setCookie
  return out
})

defineLazyGetter(requestProto, 'rawHeaders', function (this: ExpRequest) {
  const out: string[] = []
  this[kState].ctx.req.raw.headers.forEach((value, key) => {
    out.push(key, value)
  })
  return out
})

defineLazyGetter(requestProto, 'protocol', function (this: ExpRequest) {
  return this[kState].parsed.protocol.replace(':', '')
})

defineLazyGetter(requestProto, 'secure', function (this: ExpRequest) {
  return this.protocol === 'https'
})

defineLazyGetter(requestProto, 'host', function (this: ExpRequest) {
  const raw = (headerOf(this, 'host') as string | undefined) ?? this[kState].parsed.host
  if (!raw) return ''
  // Express 4 strips the port, Express 5 keeps it
  if (this[kState].compat === '4') return stripPort(raw)
  return raw
})

defineLazyGetter(requestProto, 'hostname', function (this: ExpRequest) {
  const raw = (headerOf(this, 'host') as string | undefined) ?? this[kState].parsed.host
  return raw ? stripPort(raw) : ''
})

function stripPort(host: string): string {
  // Keep IPv6 literals such as [::1]:3000 intact
  if (host.startsWith('[')) {
    const close = host.indexOf(']')
    return close === -1 ? host : host.slice(0, close + 1)
  }
  const colon = host.indexOf(':')
  return colon === -1 ? host : host.slice(0, colon)
}

defineLazyGetter(requestProto, 'xhr', function (this: ExpRequest) {
  const v = headerOf(this, 'x-requested-with')
  return typeof v === 'string' && v.toLowerCase() === 'xmlhttprequest'
})

/**
 * `req.query`。
 *
 * Express 4 defaults to the extended parser and a normal prototype; Express 5 uses the
 * simple parser and a null prototype.
 */
defineLazyGetter(requestProto, 'query', function (this: ExpRequest) {
  const search = this[kState].parsed.search.replace(/^\?/, '')
  const setting = appSetting(this, 'query parser')

  if (typeof setting === 'function') {
    return (setting as (s: string) => unknown)(search)
  }
  if (setting === false || setting === 'false') {
    return Object.create(null) as Record<string, unknown>
  }

  const extended = setting === 'extended'
  const parsed = parseUrlencoded(search, extended)

  return this[kState].compat === '4' ? { ...parsed } : parsed
})

defineLazyGetter(requestProto, 'subdomains', function (this: ExpRequest) {
  const hostname = this.hostname
  if (!hostname) return []
  // An IP address has no subdomains
  if (/^[\d.]+$/.test(hostname) || hostname.startsWith('[')) return []
  const offset = Number(appSetting(this, 'subdomain offset') ?? 2)
  return hostname.split('.').reverse().slice(offset)
})

defineLazyGetter(requestProto, 'ips', function (this: ExpRequest) {
  const trust = appSetting(this, 'trust proxy')
  if (!trust) return []
  const forwarded = headerOf(this, 'x-forwarded-for')
  if (typeof forwarded !== 'string') return []
  return forwarded
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .reverse()
})

defineLazyGetter(requestProto, 'ip', function (this: ExpRequest) {
  const ips = this.ips
  if (ips.length > 0) return ips[0]
  return this.socket.remoteAddress
})

defineLazyGetter(requestProto, 'fresh', function (this: ExpRequest) {
  if (this.method !== 'GET' && this.method !== 'HEAD') return false
  const res = this.res as
    | { statusCode?: number; get?: (n: string) => string | undefined }
    | undefined
  const status = res?.statusCode ?? 200
  // Only 2xx and 304 can be fresh
  if (!((status >= 200 && status < 300) || status === 304)) return false

  return isFresh(
    {
      'if-none-match': str(headerOf(this, 'if-none-match')),
      'if-modified-since': str(headerOf(this, 'if-modified-since')),
      'cache-control': str(headerOf(this, 'cache-control')),
    },
    {
      etag: res?.get?.('etag'),
      'last-modified': res?.get?.('last-modified'),
    },
  )
})

defineLazyGetter(requestProto, 'stale', function (this: ExpRequest) {
  return !this.fresh
})

/** Reads an app setting, tolerating a request with no app attached. */
function appSetting(req: ExpRequest, key: string): unknown {
  const app = req.app as { settings?: Record<string, unknown> } | undefined
  return app?.settings?.[key]
}

defineLazyGetter(requestProto, 'socket', function (this: ExpRequest) {
  return makeFakeSocket(this)
})

defineLazyGetter(requestProto, 'connection', function (this: ExpRequest) {
  return this.socket
})

/**
 * Stand-in for a Node socket. on-finished, proxy-addr and morgan read it, so the
 * shape is there, but none of the operations do anything.
 */
function makeFakeSocket(req: ExpRequest): FakeSocket {
  const socket: FakeSocket = {
    remoteAddress: undefined,
    remotePort: undefined,
    encrypted: req.protocol === 'https',
    destroyed: false,
    readable: true,
    writable: true,
    setTimeout: () => socket,
    end: () => {
      socket.destroyed = true
      return socket
    },
    destroy: () => {
      socket.destroyed = true
      return socket
    },
    unref: () => socket,
    ref: () => socket,
  }
  return socket
}

Object.defineProperties(requestProto, {
  httpVersion: { value: '1.1', writable: true, configurable: true, enumerable: true },
  httpVersionMajor: { value: 1, writable: true, configurable: true, enumerable: true },
  httpVersionMinor: { value: 1, writable: true, configurable: true, enumerable: true },
  hono: {
    configurable: true,
    enumerable: false,
    get(this: ExpRequest) {
      return this[kState].ctx
    },
  },
  raw: {
    configurable: true,
    enumerable: false,
    get(this: ExpRequest) {
      return this[kState].ctx.req.raw
    },
  },
  env: {
    configurable: true,
    enumerable: false,
    get(this: ExpRequest) {
      return this[kState].ctx.env
    },
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// Construction
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateRequestOptions {
  ctx: Context
  /** Per-app prototype. */
  proto: ExpRequest
  compat: CompatMode
}

export function createRequest({ ctx, proto, compat }: CreateRequestOptions): ExpRequest {
  const req = Object.create(proto) as ExpRequest
  const parsed = new URL(ctx.req.raw.url)
  const url = parsed.pathname + parsed.search

  Object.defineProperty(req, kState, {
    value: { ctx, compat, parsed } satisfies RequestState,
    enumerable: false,
    writable: false,
    configurable: true,
  })

  req.method = ctx.req.method.toUpperCase()
  req.url = url
  req.originalUrl = url
  req.baseUrl = ''
  req.params = {}
  req.body = undefined
  req.cookies = {}
  req.signedCookies = {}
  req.complete = false

  return req
}

/**
 * Rewrites `req.url`, dropping the cached `path` derived from it.
 */
export function setRequestUrl(req: ExpRequest, url: string): void {
  req.url = url
  invalidateLazy(req, 'path')
}
