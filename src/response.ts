/**
 * Express's `res` on top of a Fetch Response.
 *
 * Writes accumulate until the response ends, then a Response is built and handed back.
 *
 *   IDLE ──── send() / json() / end(body) ────► ENDED     buffered
 *    │ write(chunk)
 *    ▼
 *  STREAMING ── end() ──► ENDED                           resolved on the first write
 */

import type { Context } from 'hono'
import { ExphonoError, report } from './diagnostics.js'
import type { CompatMode } from './inventory.js'
import { type SendOptions, sendFile } from './middleware/send.js'
import { kState } from './object-model.js'
import type { ExpRequest, FakeSocket } from './request.js'
import { MiniEmitter } from './runtime/event-emitter.js'
import { type CookieOptions, serializeCookie } from './utils/cookie.js'
import { sign } from './utils/hmac.js'
import { lookupMimeType, withCharset } from './utils/mime.js'
import { encodeUrl } from './utils/url.js'

type Phase = 'idle' | 'streaming' | 'ended'

interface ResponseState {
  ctx: Context
  compat: CompatMode
  phase: Phase
  headers: Headers
  chunks: Uint8Array[]
  emitter: MiniEmitter
  resolve: (res: Response) => void
  /** Writer used in streaming mode. */
  writer?: WritableStreamDefaultWriter<Uint8Array>
  /** Keeps the on-headers hook firing only once. */
  headWritten: boolean
}

export interface ExpResponse {
  app: unknown
  req?: ExpRequest
  locals: Record<string, unknown>
  statusCode: number
  statusMessage: string
  readonly headersSent: boolean
  readonly socket: FakeSocket | undefined
  readonly writableEnded: boolean
  readonly finished: boolean
  sendDate: boolean

  status(code: number): this
  set(field: string | Record<string, string | string[]>, value?: string | string[]): this
  header(field: string | Record<string, string | string[]>, value?: string | string[]): this
  get(field: string): string | undefined
  append(field: string, value: string | string[]): this
  type(t: string): this
  contentType(t: string): this
  vary(field: string): this
  location(url: string): this
  links(links: Record<string, string>): this
  json(body?: unknown): this
  jsonp(body?: unknown): this
  send(body?: unknown): this
  sendStatus(code: number): this
  redirect(url: string): this
  redirect(status: number, url: string): this
  cookie(name: string, value: unknown, options?: CookieOptions): this
  clearCookie(name: string, options?: CookieOptions): this
  attachment(filename?: string): this
  format(handlers: Record<string, FormatHandler>): this
  sendFile(path: string, options?: unknown, callback?: (err?: unknown) => void): this
  download(
    path: string,
    filename?: string | ((err?: unknown) => void),
    callback?: (err?: unknown) => void,
  ): this
  render(view: string, options?: unknown, callback?: (err?: unknown, html?: string) => void): this

  // Node ServerResponse surface
  setHeader(name: string, value: string | string[] | number): this
  getHeader(name: string): string | string[] | number | undefined
  getHeaders(): Record<string, string | string[] | undefined>
  getHeaderNames(): string[]
  hasHeader(name: string): boolean
  removeHeader(name: string): void
  writeHead(status?: number, reason?: string | object, headers?: object): this
  flushHeaders(): void
  write(chunk: unknown): boolean
  end(chunk?: unknown): this

  on(event: string, listener: (...a: unknown[]) => void): this
  once(event: string, listener: (...a: unknown[]) => void): this
  removeListener(event: string, listener: (...a: unknown[]) => void): this
  emit(event: string, ...args: unknown[]): boolean
  listeners(event: string): ((...a: unknown[]) => void)[]

  [kState]: ResponseState
}

/** `res.format` hands each handler the same arguments Express does. */
export type FormatHandler = (
  req: ExpRequest,
  res: ExpResponse,
  next: (err?: unknown) => void,
) => void

/** Exported as `express.response`. */
export const responseProto = {} as ExpResponse

const encoder = new TextEncoder()

function st(res: ExpResponse): ResponseState {
  return res[kState]
}

function assertOpen(res: ExpResponse, what: string): void {
  if (st(res).phase === 'ended') {
    throw new Error(`Cannot ${what} after the response has been sent`)
  }
}

function toBytes(chunk: unknown): Uint8Array {
  if (chunk == null) return new Uint8Array(0)
  if (chunk instanceof Uint8Array) return chunk
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk)
  return encoder.encode(String(chunk))
}

// ─────────────────────────────────────────────────────────────────────────────
// Headers
// ─────────────────────────────────────────────────────────────────────────────

function setHeaderValue(res: ExpResponse, name: string, value: string | string[] | number): void {
  const h = st(res).headers
  const key = String(name)
  h.delete(key)
  if (Array.isArray(value)) for (const v of value) h.append(key, String(v))
  else h.set(key, String(value))
}

const methods: Partial<ExpResponse> & Record<string, unknown> = {
  status(this: ExpResponse, code: number) {
    if (st(this).compat === '5' && (!Number.isInteger(code) || code < 100 || code > 999)) {
      throw new RangeError(`Invalid status code: ${code}. Status code must be an integer 100-999`)
    }
    this.statusCode = code
    return this
  },

  setHeader(this: ExpResponse, name: string, value: string | string[] | number) {
    setHeaderValue(this, name, value)
    return this
  },

  getHeader(this: ExpResponse, name: string) {
    const key = String(name).toLowerCase()
    if (key === 'set-cookie') {
      const all = st(this).headers.getSetCookie?.() ?? []
      return all.length > 0 ? all : undefined
    }
    return st(this).headers.get(key) ?? undefined
  },

  getHeaders(this: ExpResponse) {
    const out: Record<string, string | string[] | undefined> = {}
    st(this).headers.forEach((v, k) => {
      out[k] = v
    })
    const sc = st(this).headers.getSetCookie?.() ?? []
    if (sc.length > 0) out['set-cookie'] = sc
    return out
  },

  getHeaderNames(this: ExpResponse) {
    return Object.keys(this.getHeaders())
  },

  hasHeader(this: ExpResponse, name: string) {
    return st(this).headers.has(String(name))
  },

  removeHeader(this: ExpResponse, name: string) {
    st(this).headers.delete(String(name))
  },

  set(
    this: ExpResponse,
    field: string | Record<string, string | string[]>,
    value?: string | string[],
  ) {
    if (typeof field === 'object') {
      for (const [k, v] of Object.entries(field)) setHeaderValue(this, k, v)
      return this
    }
    setHeaderValue(this, field, value as string | string[])
    return this
  },

  get(this: ExpResponse, field: string) {
    const v = st(this).headers.get(String(field))
    return v ?? undefined
  },

  append(this: ExpResponse, field: string, value: string | string[]) {
    const values = Array.isArray(value) ? value : [value]
    for (const v of values) st(this).headers.append(String(field), String(v))
    return this
  },

  type(this: ExpResponse, t: string) {
    const value = t.includes('/') ? t : lookupMimeType(t)
    setHeaderValue(this, 'content-type', withCharset(value))
    return this
  },

  vary(this: ExpResponse, field: string) {
    const current = st(this).headers.get('vary')
    const parts = current ? current.split(/\s*,\s*/) : []
    if (!parts.includes(field)) parts.push(field)
    setHeaderValue(this, 'vary', parts.join(', '))
    return this
  },

  location(this: ExpResponse, url: string) {
    setHeaderValue(this, 'location', encodeUrl(url))
    return this
  },

  links(this: ExpResponse, links: Record<string, string>) {
    const existing = st(this).headers.get('link')
    const parts = Object.entries(links).map(([rel, url]) => `<${url}>; rel="${rel}"`)
    setHeaderValue(this, 'link', existing ? `${existing}, ${parts.join(', ')}` : parts.join(', '))
    return this
  },

  /**
   * Commits the headers.
   *
   * on-headers hooks by replacing this method, so exphono must call it internally the
   * moment headers are committed — otherwise morgan and compression silently misbehave.
   */
  writeHead(this: ExpResponse, status?: number, reason?: string | object, headers?: object) {
    const s = st(this)
    if (typeof status === 'number') this.statusCode = status
    if (typeof reason === 'string') this.statusMessage = reason
    const extra = (typeof reason === 'object' ? reason : headers) as
      | Record<string, string | string[]>
      | undefined
    if (extra) for (const [k, v] of Object.entries(extra)) setHeaderValue(this, k, v)
    s.headWritten = true
    return this
  },

  flushHeaders(this: ExpResponse) {
    commitHead(this)
  },

  json(this: ExpResponse, body?: unknown) {
    if (!st(this).headers.has('content-type')) {
      setHeaderValue(this, 'content-type', 'application/json; charset=utf-8')
    }
    return this.send(JSON.stringify(body))
  },

  send(this: ExpResponse, body?: unknown) {
    const s = st(this)
    assertOpen(this, 'send')

    let payload: Uint8Array
    if (body == null) {
      payload = new Uint8Array(0)
    } else if (typeof body === 'string') {
      // A string body is always utf-8, so a type set earlier gets the charset added
      const existing = s.headers.get('content-type')
      if (existing) setHeaderValue(this, 'content-type', withCharset(existing))
      else setHeaderValue(this, 'content-type', 'text/html; charset=utf-8')
      payload = encoder.encode(body)
    } else if (body instanceof Uint8Array) {
      if (!s.headers.has('content-type')) {
        setHeaderValue(this, 'content-type', 'application/octet-stream')
      }
      payload = body
    } else if (typeof body === 'object') {
      return this.json(body)
    } else {
      payload = encoder.encode(String(body))
    }

    finish(this, payload)
    return this
  },

  sendStatus(this: ExpResponse, code: number) {
    this.status(code)
    setHeaderValue(this, 'content-type', 'text/plain; charset=utf-8')
    return this.send(statusText(code))
  },

  redirect(this: ExpResponse, a: number | string, b?: string) {
    const status = typeof a === 'number' ? a : 302
    const url = typeof a === 'number' ? (b as string) : a
    this.status(status)
    this.location(url)
    return this.send('')
  },

  write(this: ExpResponse, chunk: unknown) {
    const s = st(this)
    if (s.phase === 'ended') throw new Error('Cannot write after the response has been sent')
    if (s.phase === 'idle') startStreaming(this)
    void s.writer?.write(toBytes(chunk))
    return true
  },

  end(this: ExpResponse, chunk?: unknown) {
    const s = st(this)
    if (s.phase === 'ended') return this
    if (s.phase === 'streaming') {
      if (chunk != null) void s.writer?.write(toBytes(chunk))
      s.phase = 'ended'
      void s.writer?.close()
      s.emitter.emit('finish')
      return this
    }
    finish(this, toBytes(chunk))
    return this
  },

  jsonp(this: ExpResponse, body?: unknown) {
    const app = this.app as { settings?: Record<string, unknown> } | undefined
    const callbackName = String(app?.settings?.['jsonp callback name'] ?? 'callback')
    const query = this.req?.query as Record<string, unknown> | undefined
    const raw = query?.[callbackName]
    const callback = Array.isArray(raw) ? raw[0] : raw

    if (typeof callback !== 'string' || callback.length === 0) return this.json(body)

    // Keep only characters valid in a callback name
    const safe = callback.replace(/[^[\]\w$.]/g, '')
    this.set('x-content-type-options', 'nosniff')
    setHeaderValue(this, 'content-type', 'text/javascript; charset=utf-8')

    const payload = escapeLineSeparators(JSON.stringify(body))
    return this.send(`/**/ typeof ${safe} === 'function' && ${safe}(${payload ?? 'null'});`)
  },

  cookie(this: ExpResponse, name: string, value: unknown, options: CookieOptions = {}) {
    let raw = typeof value === 'object' ? `j:${JSON.stringify(value)}` : String(value)

    if (options.signed) {
      // cookie-parser puts the secret on the request; without it there is nothing to sign with
      const secret = this.req?.secret
      if (!secret) throw new Error('cookieParser("secret") required for signed cookies')
      raw = `s:${sign(raw, secret)}`
    }

    const opts: CookieOptions = { ...options }
    if (opts.maxAge != null) {
      const maxAge = Number(opts.maxAge)
      if (!Number.isNaN(maxAge)) {
        // Express sends both, deriving the absolute time from the relative one
        opts.expires = new Date(Date.now() + maxAge)
        opts.maxAge = Math.floor(maxAge / 1000)
      } else {
        throw new TypeError('option maxAge is invalid')
      }
    }

    st(this).headers.append('set-cookie', serializeCookie(name, raw, opts))
    return this
  },

  clearCookie(this: ExpResponse, name: string, options: CookieOptions = {}) {
    return this.cookie(name, '', { ...options, expires: new Date(1), maxAge: 0 })
  },

  attachment(this: ExpResponse, filename?: string) {
    if (filename) this.type(extnameOf(filename))
    setHeaderValue(this, 'content-disposition', contentDisposition(filename))
    return this
  },

  format(this: ExpResponse, handlers: Record<string, FormatHandler>) {
    const req = this.req
    const next = req?.next
    const keys = Object.keys(handlers).filter((k) => k !== 'default')
    const chosen = keys.length > 0 ? req?.accepts(...keys) : false
    const key = Array.isArray(chosen) ? chosen[0] : chosen

    this.vary('Accept')

    if (typeof key === 'string' && handlers[key]) {
      // The type goes on raw; send() adds the charset afterwards
      setHeaderValue(this, 'content-type', normalizeType(key))
      handlers[key](req as ExpRequest, this, next as (e?: unknown) => void)
    } else if (handlers.default) {
      handlers.default(req as ExpRequest, this, next as (e?: unknown) => void)
    } else {
      const err = Object.assign(new Error('Not Acceptable'), {
        status: 406,
        statusCode: 406,
        types: keys.map((k) => normalizeType(k)),
      })
      if (next) next(err)
      else throw err
    }
    return this
  },

  sendFile(this: ExpResponse, path: string, options?: unknown, callback?: (e?: unknown) => void) {
    const opts = (typeof options === 'function' ? {} : (options ?? {})) as SendOptions
    const cb = (typeof options === 'function' ? options : callback) as
      | ((e?: unknown) => void)
      | undefined
    const req = this.req
    if (!req) throw new Error('res.sendFile requires a request')

    sendFile(req, this, path, opts)
      .then(() => cb?.())
      .catch((err: unknown) => {
        if (cb) cb(err)
        else req.next?.(err)
      })
    return this
  },

  download(
    this: ExpResponse,
    path: string,
    filename?: string | ((e?: unknown) => void) | Record<string, unknown>,
    options?: unknown,
    callback?: (e?: unknown) => void,
  ) {
    let name = path
    let opts: Record<string, unknown> = {}
    let cb = callback

    if (typeof filename === 'function') cb = filename
    else if (typeof filename === 'string') name = filename
    else if (filename) opts = filename

    if (typeof options === 'function') cb = options as (e?: unknown) => void
    else if (options) opts = options as Record<string, unknown>

    this.attachment(name)
    return this.sendFile(path, opts, cb)
  },

  /**
   * Lowercase `res.sendfile` was removed in Express 5; kept for compat=4.
   */
  sendfile(this: ExpResponse, path: string, options?: unknown, callback?: (e?: unknown) => void) {
    if (st(this).compat !== '4') report('EXPHONO_E008', { context: 'res.sendfile' })
    return this.sendFile(path, options, callback)
  },

  /** Not implemented yet. */
  render(this: ExpResponse, _view: string, _options?: unknown, callback?: (e?: unknown) => void) {
    const err = new ExphonoError('EXPHONO_E002', 'res.render')
    if (callback) {
      callback(err)
      return this
    }
    throw err
  },

  on(this: ExpResponse, event: string, listener: (...a: unknown[]) => void) {
    st(this).emitter.on(event, listener)
    return this
  },
  once(this: ExpResponse, event: string, listener: (...a: unknown[]) => void) {
    st(this).emitter.once(event, listener)
    return this
  },
  removeListener(this: ExpResponse, event: string, listener: (...a: unknown[]) => void) {
    st(this).emitter.removeListener(event, listener)
    return this
  },
  emit(this: ExpResponse, event: string, ...args: unknown[]) {
    return st(this).emitter.emit(event, ...args)
  },
  listeners(this: ExpResponse, event: string) {
    return st(this).emitter.listeners(event)
  },
}

methods.header = methods.set
methods.contentType = methods.type

for (const [name, value] of Object.entries(methods)) {
  Object.defineProperty(responseProto, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  })
}

Object.defineProperties(responseProto, {
  headersSent: {
    configurable: true,
    get(this: ExpResponse) {
      return st(this).phase !== 'idle'
    },
  },
  writableEnded: {
    configurable: true,
    get(this: ExpResponse) {
      return st(this).phase === 'ended'
    },
  },
  finished: {
    configurable: true,
    get(this: ExpResponse) {
      return st(this).phase === 'ended'
    },
  },
  socket: {
    configurable: true,
    get(this: ExpResponse) {
      return this.req?.socket
    },
  },
})

// ─────────────────────────────────────────────────────────────────────────────
// Finishing
// ─────────────────────────────────────────────────────────────────────────────

/** Always goes through writeHead so on-headers hooks fire. */
function commitHead(res: ExpResponse): void {
  const s = st(res)
  if (s.headWritten) return
  // Call via the instance: middleware may have replaced it
  res.writeHead(res.statusCode)
}

function finish(res: ExpResponse, payload: Uint8Array): void {
  const s = st(res)
  commitHead(res)
  s.phase = 'ended'

  const noBody = res.statusCode === 204 || res.statusCode === 304 || res.req?.method === 'HEAD'
  const body = noBody || payload.byteLength === 0 ? null : payload
  if (noBody) {
    s.headers.delete('content-type')
    s.headers.delete('content-length')
  } else {
    s.headers.set('content-length', String(payload.byteLength))
  }

  s.resolve(
    new Response(body as BodyInit | null, {
      status: res.statusCode,
      statusText: res.statusMessage || undefined,
      headers: s.headers,
    }),
  )
  s.emitter.emit('finish')
}

function startStreaming(res: ExpResponse): void {
  const s = st(res)
  commitHead(res)
  s.phase = 'streaming'
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  s.writer = writable.getWriter()
  s.headers.delete('content-length')
  s.resolve(
    new Response(readable, {
      status: res.statusCode,
      statusText: res.statusMessage || undefined,
      headers: s.headers,
    }),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Construction
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateResponseOptions {
  ctx: Context
  proto: ExpResponse
  compat: CompatMode
  resolve: (res: Response) => void
}

export function createResponse({
  ctx,
  proto,
  compat,
  resolve,
}: CreateResponseOptions): ExpResponse {
  const res = Object.create(proto) as ExpResponse

  Object.defineProperty(res, kState, {
    value: {
      ctx,
      compat,
      phase: 'idle',
      headers: new Headers(),
      chunks: [],
      emitter: new MiniEmitter(),
      resolve,
      headWritten: false,
    } satisfies ResponseState,
    enumerable: false,
    writable: false,
    configurable: true,
  })

  res.statusCode = 200
  res.statusMessage = ''
  res.sendDate = true
  // Express recreates res.locals for every request
  res.locals = Object.create(null) as Record<string, unknown>

  return res
}

/** Fires `close` when the client disconnects. */
export function abortResponse(res: ExpResponse): void {
  st(res).emitter.emit('close')
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
}

function statusText(code: number): string {
  return STATUS_TEXT[code] ?? String(code)
}

/**
 * U+2028 and U+2029 are line terminators in JavaScript and would break a JSONP body.
 */
const LINE_SEPARATORS = /[\u2028\u2029]/g

function escapeLineSeparators(json: string | undefined): string | undefined {
  if (json === undefined) return undefined
  return json.replace(LINE_SEPARATORS, (c) => (c === '\u2028' ? '\\u2028' : '\\u2029'))
}

function extnameOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename
  const dot = base.lastIndexOf('.')
  return dot === -1 ? '' : base.slice(dot + 1)
}

/** Minimal Content-Disposition builder. */
function contentDisposition(filename?: string): string {
  if (!filename) return 'attachment'
  const base = filename.split(/[\\/]/).pop() ?? filename
  // Plain ASCII names go as-is; anything else also gets an RFC 5987 filename*
  if (/^[\x20-\x7e]*$/.test(base) && !/["\\]/.test(base)) {
    return `attachment; filename="${base}"`
  }
  const ascii = base.replace(/[^\x20-\x7e]/g, '?')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(base)}`
}

/** Turns a shorthand like 'html' into a full media type, leaving full types alone. */
function normalizeType(type: string): string {
  return type.includes('/') ? type : lookupMimeType(type)
}
