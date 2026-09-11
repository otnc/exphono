/**
 * Express's `req` on top of a Fetch Request.
 *
 * Created with `Object.create(app.request)`; derived values are lazy getters on the prototype that cache onto the instance.
 */

import type { Context } from 'hono'
import { report } from './diagnostics.js'
import type { CompatMode } from './inventory.js'
import { parseUrlencoded } from './middleware/body.js'
import {
  defineLazyGetter,
  invalidateLazy,
  kNodeStream,
  kRemoteAddress,
  kState,
} from './object-model.js'
import { MiniEmitter } from './runtime/event-emitter.js'
import { accepts, acceptsSimple, isFresh, isType, parseRange } from './utils/negotiation.js'
import {
  compileTrust,
  forwardedChain,
  resolveAddress,
  resolveAllAddresses,
} from './utils/trust-proxy.js'

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
  emitter: MiniEmitter
  /** Set once the raw body stream has started being pumped into 'data'/'end' events. */
  pumpStarted: boolean
  encoding: string | null
}

export interface ExpRequest {
  app: unknown
  method: string
  url: string
  originalUrl: string
  baseUrl: string
  params: Record<string, string>
  body: unknown
  cookies?: Record<string, string>
  signedCookies?: Record<string, string>
  /** Set by cookie-parser; res.cookie({ signed: true }) needs it. */
  secret?: string
  res?: unknown
  next?: (err?: unknown) => void
  route?: unknown

  // ExpHono additions
  readonly hono: Context
  readonly raw: globalThis.Request
  readonly env: unknown

  readonly path: string
  readonly query: Record<string, unknown>
  readonly headers: Record<string, string | string[] | undefined>
  readonly rawHeaders: string[]
  readonly protocol: string
  readonly secure: boolean
  readonly host: string | undefined
  readonly hostname: string | undefined
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
  range(size: number, options?: { combine?: boolean }): unknown

  // Express 4 only; present under compat=5 too, but they report a diagnostic
  param(name: string, defaultValue?: unknown): unknown
  acceptsCharset(...charsets: string[]): string | string[] | false
  acceptsEncoding(...encodings: string[]): string | string[] | false
  acceptsLanguage(...langs: string[]): string | string[] | false

  // Node `Readable`-like surface
  on(event: string, listener: (...a: unknown[]) => void): this
  addListener(event: string, listener: (...a: unknown[]) => void): this
  once(event: string, listener: (...a: unknown[]) => void): this
  removeListener(event: string, listener: (...a: unknown[]) => void): this
  emit(event: string, ...args: unknown[]): boolean
  listeners(event: string): ((...a: unknown[]) => void)[]
  setEncoding(encoding: string): this
  pause(): this
  resume(): this
  isPaused(): boolean

  [kState]: RequestState
}

/** Exported as `express.request`. */
export const requestProto = {} as ExpRequest

// ─────────────────────────────────────────────────────────────────────────────
// Methods
// ─────────────────────────────────────────────────────────────────────────────

function headerOf(req: ExpRequest, name: string): string | string[] | undefined {
  const lower = String(name).toLowerCase()

  // `req.headers` is a plain object once materialized (see the lazy getter below), and Express code sometimes mutates it directly expecting `req.get()` to see the change.
  if (Object.hasOwn(req, 'headers')) {
    const materialized = (req.headers as Record<string, string | string[] | undefined>)[lower]
    if (materialized !== undefined) return materialized
    if (lower === 'referer' || lower === 'referrer') {
      return req.headers.referer ?? req.headers.referrer
    }
    return undefined
  }

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

  // Node `Readable`-like surface: connect-style middleware reads the request body directly via `req.on('data'/'end')` rather than through a body-parser.

  on(this: ExpRequest, event: string, listener: (...a: unknown[]) => void) {
    const stream = nodeStreamOf(this)
    if (stream) {
      stream.on(event, listener)
      return this
    }
    if (event === 'data' || event === 'readable') startBodyPump(this)
    this[kState].emitter.on(event, listener)
    return this
  },
  addListener(this: ExpRequest, event: string, listener: (...a: unknown[]) => void) {
    return this.on(event, listener)
  },
  once(this: ExpRequest, event: string, listener: (...a: unknown[]) => void) {
    const stream = nodeStreamOf(this)
    if (stream) {
      stream.once(event, listener)
      return this
    }
    if (event === 'data' || event === 'readable') startBodyPump(this)
    this[kState].emitter.once(event, listener)
    return this
  },
  removeListener(this: ExpRequest, event: string, listener: (...a: unknown[]) => void) {
    const stream = nodeStreamOf(this)
    if (stream) {
      stream.removeListener(event, listener)
      return this
    }
    this[kState].emitter.removeListener(event, listener)
    return this
  },
  emit(this: ExpRequest, event: string, ...args: unknown[]) {
    return this[kState].emitter.emit(event, ...args)
  },
  listeners(this: ExpRequest, event: string) {
    const stream = nodeStreamOf(this)
    if (stream) return stream.listeners(event)
    return this[kState].emitter.listeners(event)
  },
  setEncoding(this: ExpRequest, encoding: string) {
    const stream = nodeStreamOf(this)
    if (stream) {
      stream.setEncoding(encoding)
      return this
    }
    this[kState].encoding = encoding
    return this
  },
  pause(this: ExpRequest) {
    nodeStreamOf(this)?.pause()
    return this
  },
  resume(this: ExpRequest) {
    const stream = nodeStreamOf(this)
    if (stream) {
      stream.resume()
      return this
    }
    startBodyPump(this)
    return this
  },
  isPaused(this: ExpRequest) {
    return nodeStreamOf(this)?.isPaused() ?? false
  },
}

interface BufferLike {
  from(
    buffer: ArrayBufferLike,
    byteOffset: number,
    length: number,
  ): { toString(enc: string): string }
}

interface NodeReadableLike {
  on(event: string, listener: (...a: unknown[]) => void): unknown
  once(event: string, listener: (...a: unknown[]) => void): unknown
  removeListener(event: string, listener: (...a: unknown[]) => void): unknown
  listeners(event: string): ((...a: unknown[]) => void)[]
  setEncoding(encoding: string): unknown
  pause(): unknown
  resume(): unknown
  isPaused(): boolean
}

/**
 * On Node, the real `IncomingMessage` behind this request -- kept around because a bodyless method's Fetch `Request` (GET, HEAD, ...) can't carry `init.body` at all, yet connect-style middleware still needs to read those raw bytes directly.
 */
function nodeStreamOf(req: ExpRequest): NodeReadableLike | undefined {
  const raw = req[kState].ctx.req.raw as unknown as Record<symbol, unknown>
  return raw[kNodeStream] as NodeReadableLike | undefined
}

/**
 * Pumps the Fetch body stream into 'data'/'end' events, matching Node's `IncomingMessage`.
 * Starts on the first 'data'/'readable' listener or an explicit `resume()`, same as a real stream going into flowing mode.
 */
function startBodyPump(req: ExpRequest): void {
  const state = req[kState]
  if (state.pumpStarted) return
  state.pumpStarted = true

  const body = state.ctx.req.raw.body
  if (!body) {
    queueMicrotask(() => req.emit('end'))
    return
  }

  const reader = body.getReader()
  const pump = (): void => {
    reader.read().then(
      ({ done, value }) => {
        if (done) {
          req.emit('end')
          return
        }
        req.emit('data', toChunk(value, state.encoding))
        pump()
      },
      (err: unknown) => {
        req.emit('error', err)
      },
    )
  }
  pump()
}

/** On Node and Bun, a real `Buffer` (optionally decoded to a string); elsewhere raw bytes or a decoded string. */
function toChunk(value: Uint8Array, encoding: string | null): unknown {
  const ctor = (globalThis as { Buffer?: BufferLike }).Buffer
  if (ctor) {
    const buf = ctor.from(value.buffer, value.byteOffset, value.byteLength)
    return encoding ? buf.toString(encoding) : buf
  }
  return encoding ? new TextDecoder(encoding).decode(value) : value
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
  // Reads back from the socket rather than the parsed URL, so test code that flips req.socket.encrypted after the fact (a common idiom for simulating TLS termination at a proxy) is actually reflected here, the way it would be against a real socket.
  const direct = this.socket.encrypted ? 'https' : 'http'
  if (!trustFn(this)(this.socket.remoteAddress ?? '', 0)) return direct
  const forwarded = str(headerOf(this, 'x-forwarded-proto'))
  if (!forwarded) return direct
  return (forwarded.split(',')[0] ?? direct).trim() || direct
})

defineLazyGetter(requestProto, 'secure', function (this: ExpRequest) {
  return this.protocol === 'https'
})

defineLazyGetter(requestProto, 'host', function (this: ExpRequest) {
  const raw = hostHeader(this)
  if (!raw) return undefined
  // Express 4 strips the port, Express 5 keeps it
  if (this[kState].compat === '4') return stripPort(raw)
  return raw
})

defineLazyGetter(requestProto, 'hostname', function (this: ExpRequest) {
  const raw = hostHeader(this)
  return raw ? stripPort(raw) : undefined
})

/**
 * `undefined` when there is genuinely no Host header to report, matching Express -- a request built from a URL always has *some* host to fall back to, but the Host header itself, once materialized onto req.headers, is the one Express code actually reads.
 */
function hostHeader(req: ExpRequest): string | undefined {
  if (trustFn(req)(req.socket.remoteAddress ?? '', 0)) {
    const forwarded = str(headerOf(req, 'x-forwarded-host'))
    // Only the first value is meaningful; the rest are upstream hops
    if (forwarded) return (forwarded.split(',')[0] ?? '').trim()
  }
  return Object.hasOwn(req, 'headers')
    ? str(headerOf(req, 'host'))
    : (str(headerOf(req, 'host')) ?? req[kState].parsed.host)
}

/** The compiled `trust proxy` setting for this request's app. */
function trustFn(req: ExpRequest) {
  return compileTrust(appSetting(req, 'trust proxy') as never)
}

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
 * `req.query`.
 *
 * Express 4 defaults to the extended parser and a normal prototype; Express 5 uses the simple parser and a null prototype.
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
  const offset = Number(appSetting(this, 'subdomain offset') ?? 2)
  // An IP address has no subdomains to split -- it's kept whole, so an offset of 0 (rather than the default 2) still reports it
  const isIp = /^[\d.]+$/.test(hostname) || hostname.startsWith('[')
  const parts = isIp ? [hostname] : hostname.split('.').reverse()
  return parts.slice(offset)
})

defineLazyGetter(requestProto, 'ips', function (this: ExpRequest) {
  if (!trustFn(this)(this.socket.remoteAddress ?? '', 0)) return []
  const chain = forwardedChain(str(headerOf(this, 'x-forwarded-for')))
  return resolveAllAddresses(this.socket.remoteAddress, chain, trustFn(this))
})

defineLazyGetter(requestProto, 'ip', function (this: ExpRequest) {
  return resolveAddress(
    this.socket.remoteAddress,
    forwardedChain(str(headerOf(this, 'x-forwarded-for'))),
    trustFn(this),
  )
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
 * Stand-in for a Node socket. on-finished, proxy-addr and morgan read it, so the shape is there, but none of the operations do anything.
 */
function makeFakeSocket(req: ExpRequest): FakeSocket {
  const raw = req[kState].ctx.req.raw as unknown as Record<symbol, string | undefined>
  const socket: FakeSocket = {
    remoteAddress: raw[kRemoteAddress],
    remotePort: undefined,
    // Read the URL directly: req.protocol consults the socket, which would recurse
    encrypted: req[kState].parsed.protocol === 'https:',
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
    value: {
      ctx,
      compat,
      parsed,
      emitter: new MiniEmitter(),
      pumpStarted: false,
      encoding: null,
    } satisfies RequestState,
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
  // Left unset on purpose: cookie-parser skips the request entirely when req.cookies already exists, so pre-populating them disables it
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
