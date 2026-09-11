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
import { report } from './diagnostics.js'
import type { CompatMode } from './inventory.js'
import { type SendOptions, sendFile } from './middleware/send.js'
import { kActualStatus, kState } from './object-model.js'
import type { ExpRequest, FakeSocket } from './request.js'
import { MiniEmitter } from './runtime/event-emitter.js'
import { resolvePath } from './runtime/files.js'
import { type CookieOptions, serializeCookie } from './utils/cookie.js'
import { strongEtag, weakBodyEtag } from './utils/etag.js'
import { sign } from './utils/hmac.js'
import { escapeHtml } from './utils/html.js'
import { lookupMimeType, withCharset } from './utils/mime.js'
import { encodeUrl } from './utils/url.js'

type Phase = 'idle' | 'streaming' | 'ended'

interface ResponseState {
  ctx: Context
  compat: CompatMode
  phase: Phase
  headers: Headers
  /**
   * `Headers` (the Fetch standard) has no concept of an array value: appending the same key repeatedly just joins them with a comma on read. Node's `res.setHeader`/`getHeader` do remember the original array, though, and Express's res.get()/getHeader() rely on getting it back verbatim -- so the array as given is kept here, keyed lower-case, alongside the joined form actually written to `headers`.
   */
  rawValues: Map<string, string | string[]>
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
  get(field: string): string | string[] | number | undefined
  append(field: string, value: string | string[]): this
  type(t: string): this
  contentType(t: string): this
  vary(field?: string | string[]): this
  location(url: string): this
  links(links: Record<string, string | string[]>): this
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
    filename?: string | SendOptions | ((err?: unknown) => void),
    options?: SendOptions | ((err?: unknown) => void),
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
  const s = st(res)
  if (s.headWritten) {
    const err = new Error('Cannot set headers after they are sent to the client')
    err.name = 'Error [ERR_HTTP_HEADERS_SENT]'
    throw err
  }
  const key = String(name)
  s.headers.delete(key)
  if (Array.isArray(value)) {
    const strs = value.map(String)
    s.rawValues.set(key.toLowerCase(), strs)
    for (const v of strs) s.headers.append(key, v)
  } else {
    s.rawValues.set(key.toLowerCase(), String(value))
    s.headers.set(key, String(value))
  }
}

const methods: Partial<ExpResponse> & Record<string, unknown> = {
  status(this: ExpResponse, code: number) {
    if (!Number.isInteger(code) || code < 100 || code > 999) {
      throw new TypeError(`Invalid status code: ${code}`)
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
    const raw = st(this).rawValues.get(key)
    if (raw !== undefined) return raw
    if (key === 'set-cookie') {
      const all = st(this).headers.getSetCookie?.() ?? []
      return all.length > 0 ? all : undefined
    }
    return st(this).headers.get(key) ?? undefined
  },

  getHeaders(this: ExpResponse) {
    const out: Record<string, string | string[] | undefined> = {}
    st(this).headers.forEach((v, k) => {
      out[k] = st(this).rawValues.get(k) ?? v
    })
    const sc = st(this).headers.getSetCookie?.() ?? []
    if (sc.length > 0 && !st(this).rawValues.has('set-cookie')) out['set-cookie'] = sc
    return out
  },

  getHeaderNames(this: ExpResponse) {
    return Object.keys(this.getHeaders())
  },

  hasHeader(this: ExpResponse, name: string) {
    return st(this).headers.has(String(name))
  },

  removeHeader(this: ExpResponse, name: string) {
    const s = st(this)
    s.headers.delete(String(name))
    s.rawValues.delete(String(name).toLowerCase())
  },

  set(
    this: ExpResponse,
    field: string | Record<string, string | string[]>,
    value?: string | string[],
  ) {
    if (typeof field === 'object') {
      for (const [k, v] of Object.entries(field)) this.set(k, v)
      return this
    }
    if (field.toLowerCase() === 'content-type') {
      if (Array.isArray(value)) throw new TypeError('Content-Type cannot be set to an Array')
      setHeaderValue(this, field, withCharset(String(value), st(this).compat))
      return this
    }
    setHeaderValue(this, field, value as string | string[])
    return this
  },

  get(this: ExpResponse, field: string) {
    return this.getHeader(field)
  },

  append(this: ExpResponse, field: string, value: string | string[]) {
    const s = st(this)
    const key = String(field).toLowerCase()
    // A prior set(name, array) leaves a raw array cached; appending onto it must extend that array rather than let the stale cache shadow the new value.
    const existing = s.rawValues.get(key)
    const values = Array.isArray(value) ? value : [value]
    if (existing !== undefined) {
      const merged = (Array.isArray(existing) ? existing : [existing]).concat(values.map(String))
      s.rawValues.set(key, merged)
    } else {
      s.rawValues.delete(key)
    }
    for (const v of values) s.headers.append(String(field), String(v))
    return this
  },

  type(this: ExpResponse, t: string) {
    const value = t.includes('/') ? t : lookupMimeType(t)
    setHeaderValue(this, 'content-type', withCharset(value, st(this).compat))
    return this
  },

  vary(this: ExpResponse, field?: string | string[]) {
    if (!field || (Array.isArray(field) && field.length === 0)) {
      if (field === undefined) throw new TypeError('field argument is required')
      if (typeof field === 'string' && field.length === 0) {
        throw new TypeError('field argument is required')
      }
      // An empty array has nothing to add and leaves an unset header unset, matching the `vary` package rather than writing out an empty Vary header.
      return this
    }

    const fields = Array.isArray(field) ? field : field.split(/\s*,\s*/)
    const current = st(this).headers.get('vary') ?? ''
    if (current === '*') return this

    const seen = current ? current.split(/\s*,\s*/).map((v) => v.toLowerCase()) : []
    let val = current
    for (const f of fields) {
      if (f === '*') {
        setHeaderValue(this, 'vary', '*')
        return this
      }
      const lower = f.toLowerCase()
      if (!seen.includes(lower)) {
        seen.push(lower)
        val = val ? `${val}, ${f}` : f
      }
    }

    if (val) setHeaderValue(this, 'vary', val)
    return this
  },

  location(this: ExpResponse, url: string) {
    setHeaderValue(this, 'location', encodeUrl(url))
    return this
  },

  links(this: ExpResponse, links: Record<string, string | string[]>) {
    const existing = st(this).headers.get('link')
    const parts = Object.entries(links).flatMap(([rel, urls]) =>
      (Array.isArray(urls) ? urls : [urls]).map((url) => `<${url}>; rel="${rel}"`),
    )
    setHeaderValue(this, 'link', existing ? `${existing}, ${parts.join(', ')}` : parts.join(', '))
    return this
  },

  /**
   * Commits the headers.
   *
   * on-headers hooks by replacing this method, so ExpHono must call it internally the moment headers are committed — otherwise morgan and compression silently misbehave.
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

  json(this: ExpResponse, ...args: unknown[]) {
    const body = resolveLegacyStatusArg(this, args)
    if (!st(this).headers.has('content-type')) {
      setHeaderValue(this, 'content-type', 'application/json; charset=utf-8')
    }
    return this.send(stringifyJson(this.app, body))
  },

  send(this: ExpResponse, body?: unknown) {
    const s = st(this)
    assertOpen(this, 'send')

    // Express only populates Content-Length / ETag when a body argument was actually given — a bare res.send() sends neither, unlike res.send(null)'s empty string.
    const bodyProvided = body !== undefined

    let payload: Uint8Array
    if (typeof body === 'string') {
      // A string body is always written as utf-8, overriding any charset already on the content-type rather than just filling one in when none is present.
      if (!s.headers.has('content-type')) this.set('content-type', 'text/html')
      const existing = s.headers.get('content-type')
      if (existing) setHeaderValue(this, 'content-type', forceUtf8(existing))
      payload = encoder.encode(body)
    } else if (body == null) {
      payload = new Uint8Array(0)
    } else if (body instanceof Uint8Array) {
      if (!s.headers.has('content-type')) {
        setHeaderValue(this, 'content-type', 'application/octet-stream')
      }
      payload = body
    } else {
      // Booleans, numbers, plain objects and arrays are all serialized as JSON, matching
      // Express's own res.send() dispatch.
      return this.json(body)
    }

    if (bodyProvided) {
      if (!s.headers.has('content-length')) {
        setHeaderValue(this, 'content-length', String(payload.byteLength))
      }
      if (!s.headers.has('etag')) {
        const tag = computeEtag(this.app, payload)
        if (tag) setHeaderValue(this, 'etag', tag)
      }
    }
    if (this.req?.fresh) this.status(304)

    if (this.statusCode === 204 || this.statusCode === 304) {
      s.headers.delete('content-type')
      s.headers.delete('content-length')
      s.headers.delete('transfer-encoding')
      payload = new Uint8Array(0)
    } else if (this.statusCode === 205) {
      setHeaderValue(this, 'content-length', '0')
      s.headers.delete('transfer-encoding')
      payload = new Uint8Array(0)
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

    this.location(url)
    const address = this.get('location') as string

    let body = ''
    this.format({
      text: () => {
        body = `${statusText(status)}. Redirecting to ${address}`
      },
      html: () => {
        body = `<p>${statusText(status)}. Redirecting to ${escapeHtml(address)}</p>`
      },
      default: () => {
        body = ''
      },
    })

    this.status(status)
    setHeaderValue(this, 'content-length', String(encoder.encode(body).byteLength))
    this.end(body)

    return this
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

  jsonp(this: ExpResponse, ...args: unknown[]) {
    const body = resolveLegacyStatusArg(this, args)
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

    const json = stringifyJson(this.app, body)
    // res.jsonp(undefined) calls the callback with no arguments, not literal "null"
    const payload = json === undefined ? '' : escapeLineSeparators(json)
    return this.send(`/**/ typeof ${safe} === 'function' && ${safe}(${payload});`)
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
    const opts: CookieOptions = { path: '/', ...options, expires: new Date(1) }
    delete opts.maxAge
    return this.cookie(name, '', opts)
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
    // A handler key may carry parameters ('text/plain; charset=utf-8'): negotiation matches on the bare type, so that's stripped off before it's offered up, and the stripped form is also what ends up in Content-Type / a 406's error.types.
    const bareKeys = keys.map((k) => (k.split(';')[0] ?? k).trim())
    const chosen = keys.length > 0 ? req?.accepts(...bareKeys) : false
    const chosenValue = Array.isArray(chosen) ? chosen[0] : chosen
    const idx = typeof chosenValue === 'string' ? bareKeys.indexOf(chosenValue) : -1

    this.vary('Accept')

    if (idx !== -1) {
      const key = keys[idx] as string
      // The type goes on raw; send() adds the charset afterwards
      setHeaderValue(this, 'content-type', normalizeType(bareKeys[idx] as string))
      handlers[key](req as ExpRequest, this, next as (e?: unknown) => void)
    } else if (handlers.default) {
      handlers.default(req as ExpRequest, this, next as (e?: unknown) => void)
    } else {
      const err = Object.assign(new Error('Not Acceptable'), {
        status: 406,
        statusCode: 406,
        types: bareKeys.map((k) => normalizeType(k)),
      })
      if (next) next(err)
      else throw err
    }
    return this
  },

  sendFile(this: ExpResponse, path: string, options?: unknown, callback?: (e?: unknown) => void) {
    if (!path) throw new TypeError('path argument is required to res.sendFile')
    if (typeof path !== 'string') throw new TypeError('path must be a string to res.sendFile')

    const opts = (typeof options === 'function' ? {} : (options ?? {})) as SendOptions
    const cb = (typeof options === 'function' ? options : callback) as
      | ((e?: unknown) => void)
      | undefined
    const req = this.req
    if (!req) throw new Error('res.sendFile requires a request')

    // Express always wires this from the app setting, regardless of what (if anything)
    // the caller passed for `options.etag` -- there's no per-call override.
    const app = this.app as { enabled?: (key: string) => boolean } | undefined
    opts.etag = app?.enabled?.('etag') ?? true

    // Express re-encodes the raw filesystem path with `encodeURI` before handing it to `send`, so that a literal `%` or space in the path round-trips through the decodeURIComponent() that `send` applies internally instead of being misread as an escape sequence.
    sendFile(req, this, encodeURI(path), opts)
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
    filename?: string | ((e?: unknown) => void) | SendOptions,
    options?: unknown,
    callback?: (e?: unknown) => void,
  ) {
    let done = callback
    let name: string | undefined = typeof filename === 'string' ? filename : undefined
    let opts = (
      typeof options === 'object' && options !== null ? options : null
    ) as SendOptions | null

    if (typeof filename === 'function') {
      done = filename
      name = undefined
      opts = null
    } else if (typeof options === 'function') {
      done = options as (e?: unknown) => void
      opts = null
    }
    if (
      typeof filename === 'object' &&
      filename !== null &&
      (typeof options === 'function' || options === undefined)
    ) {
      name = undefined
      opts = filename
    }

    const headers: Record<string, string> = {
      'content-disposition': contentDisposition(name ?? path),
    }
    if (opts?.headers) {
      for (const [key, value] of Object.entries(opts.headers)) {
        if (key.toLowerCase() !== 'content-disposition') headers[key] = value
      }
    }

    const merged: SendOptions = { ...opts, headers }

    // With no root, Express resolves the path against the process's cwd first
    const req = this.req
    if (merged.root) {
      this.sendFile(path, merged, done)
    } else {
      resolvePath(path)
        .then((fullPath) => this.sendFile(fullPath, merged, done))
        .catch((err) => {
          if (done) done(err)
          else req?.next?.(err)
        })
    }
    return this
  },

  /**
   * Lowercase `res.sendfile` was removed in Express 5; kept for compat=4.
   */
  sendfile(this: ExpResponse, path: string, options?: unknown, callback?: (e?: unknown) => void) {
    if (st(this).compat !== '4') report('EXPHONO_E008', { context: 'res.sendfile' })
    return this.sendFile(path, options, callback)
  },

  render(
    this: ExpResponse,
    view: string,
    options?: unknown,
    callback?: (e?: unknown, html?: string) => void,
  ) {
    const req = this.req
    const app = req?.app as
      | { render: (v: string, o: unknown, cb: (e?: unknown, h?: string) => void) => void }
      | undefined
    const isCb = typeof options === 'function'
    let done = (isCb ? options : callback) as ((e?: unknown, html?: string) => void) | undefined
    const opts = (isCb ? {} : (options ?? {})) as Record<string, unknown>

    // res.locals loses to any locals passed at the call site, per Express
    opts._locals = this.locals

    done ??= (err, html) => {
      if (err) {
        req?.next?.(err)
        return
      }
      this.send(html)
    }

    app?.render(view, opts, done)
    return this
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
      const s = st(this)
      // Node flips this the moment writeHead() runs, not only once the body starts flowing -- headWritten tracks that; phase only moves once a write/end actually begins, which would otherwise miss the writeHead()-then-nothing-yet window.
      return s.headWritten || s.phase !== 'idle'
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

type EtagFn = (body: Uint8Array, encoding?: string) => string | false | undefined

/** `app.set('etag', ...)`: `true`/`'weak'` (the default), `'strong'`, `false`, or a function. */
function computeEtag(app: unknown, payload: Uint8Array): string | undefined {
  const setting = (app as { get?: (key: string) => unknown } | undefined)?.get?.('etag')
  if (setting === false || setting === undefined) return undefined
  if (typeof setting === 'function') return (setting as EtagFn)(payload) || undefined
  if (setting === 'strong') return strongEtag(payload)
  return weakBodyEtag(payload)
}

/** Replaces (or adds) the charset parameter with `utf-8`, for a string body written as such. */
function forceUtf8(type: string): string {
  if (/charset\s*=/i.test(type)) return type.replace(/charset\s*=\s*[^;]+/i, 'charset=utf-8')
  return `${type}; charset=utf-8`
}

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

  // A HEAD response still reports the headers a GET would have sent -- only the body bytes are withheld -- whereas 204/304 genuinely have neither a body nor these headers.
  const suppressHeaders = res.statusCode === 204 || res.statusCode === 304
  const noBody = suppressHeaders || res.req?.method === 'HEAD'
  const body = noBody || payload.byteLength === 0 ? null : payload
  if (suppressHeaders) {
    s.headers.delete('content-type')
    s.headers.delete('content-length')
  } else {
    s.headers.set('content-length', String(payload.byteLength))
  }

  s.resolve(buildResponse(body as BodyInit | null, res, s.headers))
  s.emitter.emit('finish')
}

function startStreaming(res: ExpResponse): void {
  const s = st(res)
  commitHead(res)
  s.phase = 'streaming'
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  s.writer = writable.getWriter()
  s.resolve(buildResponse(readable, res, s.headers))
}

/**
 * The Fetch `Response` constructor rejects a status outside 200-599, but Express code sets things like `res.status(101)` freely. Out-of-range values are built with a placeholder and the real status is stashed for the Node adapter to substitute back in.
 */
function buildResponse(body: BodyInit | null, res: ExpResponse, headers: Headers): Response {
  const code = res.statusCode
  const inRange = Number.isInteger(code) && code >= 200 && code <= 599
  const response = new Response(body, {
    status: inRange ? code : 200,
    statusText: inRange ? res.statusMessage || undefined : undefined,
    headers,
  })
  if (!inRange) {
    Object.defineProperty(response, kActualStatus, { value: code, configurable: true })
  }
  return response
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
      rawValues: new Map(),
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

function escapeLineSeparators(json: string): string {
  return json.replace(LINE_SEPARATORS, (c) => (c === '\u2028' ? '\\u2028' : '\\u2029'))
}

/**
 * Express 4's deprecated `res.json(status, obj)` / `res.json(obj, status)` two-argument
 * forms (also `res.jsonp()`): with exactly two arguments, whichever one is a number is the
 * status and the other is the body -- the second argument wins the tie when both are
 * numbers (`res.json(200, 201)` sends body `200` with status `201`). Express 5 removed
 * this form entirely -- a second argument there is simply ignored, same as calling any
 * other function with an extra argument.
 */
function resolveLegacyStatusArg(res: ExpResponse, args: unknown[]): unknown {
  if (args.length !== 2 || st(res).compat !== '4') return args[0]
  const [first, second] = args
  if (typeof second === 'number') {
    res.statusCode = second
    return first
  }
  res.statusCode = first as number
  return second
}

/** `app.set('json replacer'/'json spaces'/'json escape', ...)`, honored by res.json()/jsonp(). */
function stringifyJson(app: unknown, value: unknown): string | undefined {
  const get = (app as { get?: (key: string) => unknown } | undefined)?.get
  const replacer = get?.('json replacer') as
    | ((this: unknown, key: string, value: unknown) => unknown)
    | undefined
  const spaces = get?.('json spaces') as string | number | undefined
  const shouldEscape = get?.('json escape')

  const json =
    replacer || spaces
      ? JSON.stringify(value, replacer as (key: string, value: unknown) => unknown, spaces)
      : JSON.stringify(value)

  if (shouldEscape && typeof json === 'string') {
    return json.replace(/[<>&]/g, (c) => {
      if (c === '<') return '\\u003c'
      if (c === '>') return '\\u003e'
      return '\\u0026'
    })
  }
  return json
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
