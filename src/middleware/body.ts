/**
 * Built-in body parsers.
 *
 * Written from scratch rather than wrapping body-parser: it assumes Node streams, and reading the Fetch Request directly is cheaper. Using the real body-parser still works, since `req` keeps its Node stream surface.
 */

import type { CompatMode } from '../inventory.js'
import { kState } from '../object-model.js'
import type { ExpRequest } from '../request.js'
import type { ExpResponse } from '../response.js'
import type { NextFunction, RequestHandler } from '../router/index.js'
import { lookupMimeType } from '../utils/mime.js'

export type TypeOption = string | string[] | ((req: ExpRequest) => boolean)

export interface BodyOptions {
  /** Content types to accept, or a predicate. */
  type?: TypeOption
  /** Byte limit, as a number or '100kb'. */
  limit?: number | string
  /** Reject the body before parsing by throwing from here. */
  verify?: (req: ExpRequest, res: ExpResponse, buf: Uint8Array, encoding: string) => void
  /** Decompress gzip / deflate bodies. */
  inflate?: boolean
  /** urlencoded only: parse nested keys. */
  extended?: boolean
  /** urlencoded only: maximum number of parameters to accept. */
  parameterLimit?: number
  /** JSON only: only accept objects and arrays at the top level. */
  strict?: boolean
  /** Charset assumed when the request does not name one. */
  defaultCharset?: string
  /** Internal: which body-parser convention to follow (see `makeParser`). */
  compat?: CompatMode
}

const DEFAULT_LIMIT = 100 * 1024

function parseLimit(limit: number | string | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT
  if (typeof limit === 'number') return limit
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(limit.trim())
  if (!m) return DEFAULT_LIMIT
  const unit = (m[2] ?? 'b').toLowerCase()
  const mult = unit === 'kb' ? 1024 : unit === 'mb' ? 1024 ** 2 : unit === 'gb' ? 1024 ** 3 : 1
  return Math.round(Number(m[1]) * mult)
}

function contentTypeOf(req: ExpRequest): string {
  const v = req.get('content-type')
  return (typeof v === 'string' ? v : '').split(';')[0]?.trim().toLowerCase() ?? ''
}

function charsetOf(req: ExpRequest): string {
  const v = req.get('content-type')
  const m = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(typeof v === 'string' ? v : '')
  return (m?.[1] ?? '').trim().toLowerCase()
}

function typeMatches(req: ExpRequest, expected: TypeOption): boolean {
  if (typeof expected === 'function') return Boolean(expected(req))
  const actual = contentTypeOf(req)
  if (!actual) return false
  const list = Array.isArray(expected) ? expected : [expected]
  return list.some((want) => {
    // A bare extension like 'urlencoded' or 'json' resolves through the same table
    // `res.type()` uses, matching `type-is`'s support for mime-db extension names.
    const w = (want.includes('/') ? want : lookupMimeType(want)).toLowerCase()
    if (w === '*/*' || w === actual) return true
    if (w.endsWith('/*')) return actual.startsWith(w.slice(0, -1))
    // Suffix form, e.g. '+json'
    if (w.startsWith('+')) return actual.endsWith(w)
    return false
  })
}

/**
 * Whether the request carries no body at all.
 *
 * The headers alone are not enough: a Request built in-process and handed straight to `app.fetch()` has a body stream but no content-length.
 */
function hasNoBody(req: ExpRequest): boolean {
  if (req[kState].ctx.req.raw.body !== null) return false
  return req.get('content-length') === undefined && req.get('transfer-encoding') === undefined
}

class BodyError extends Error {
  status: number
  statusCode: number
  type: string
  body?: string
  expected?: number
  length?: number
  limit?: number
  charset?: string
  encoding?: string

  constructor(status: number, type: string, message: string) {
    super(message)
    this.name = 'BodyError'
    this.status = status
    this.statusCode = status
    this.type = type
  }
}

const INFLATABLE = new Set(['gzip', 'deflate'])

async function readBytes(req: ExpRequest, limit: number, inflate: boolean): Promise<Uint8Array> {
  const declared = req.get('content-length')
  const hasLength = typeof declared === 'string' && declared !== ''

  if (hasLength) {
    if (!/^\d+$/.test(declared)) {
      throw new BodyError(400, 'request.size.invalid', 'invalid content-length')
    }
    if (Number(declared) > limit) {
      const err = new BodyError(413, 'entity.too.large', 'request entity too large')
      err.expected = Number(declared)
      err.length = Number(declared)
      err.limit = limit
      throw err
    }
  }

  const encoding = String(req.get('content-encoding') ?? 'identity').toLowerCase()
  let stream = req[kState].ctx.req.raw.body

  if (encoding !== 'identity') {
    if (!inflate) {
      const err = new BodyError(415, 'encoding.unsupported', 'content encoding unsupported')
      err.encoding = encoding
      throw err
    }
    if (!INFLATABLE.has(encoding)) {
      const err = new BodyError(
        415,
        'encoding.unsupported',
        `unsupported content encoding "${encoding}"`,
      )
      err.encoding = encoding
      throw err
    }
    if (stream) stream = stream.pipeThrough(new DecompressionStream(encoding as 'gzip' | 'deflate'))
  }

  const chunks: Uint8Array[] = []
  let total = 0

  if (stream) {
    const reader = stream.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > limit) {
          const err = new BodyError(413, 'entity.too.large', 'request entity too large')
          err.limit = limit
          err.length = total
          throw err
        }
        chunks.push(value)
      }
    } catch (e) {
      // The client may still be sending bytes we've decided not to read (e.g. a body over the limit, mid-upload). Cancelling propagates through DecompressionStream to the underlying Node request, instead of leaving the connection hung waiting for an end that a caller who already got their error response has no reason to send.
      reader.cancel().catch(() => undefined)
      // A malformed gzip/deflate body surfaces as a generic decompression error here;
      // Express reports that as a 400 rather than letting it fall through as a 500.
      if (e instanceof BodyError) throw e
      throw new BodyError(400, 'encoding.decode.failed', (e as Error)?.message ?? 'stream error')
    }
  }

  // Only meaningful without inflation: the declared length counts compressed bytes
  if (hasLength && encoding === 'identity' && Number(declared) !== total) {
    const err = new BodyError(
      400,
      'request.size.invalid',
      'request size did not match content length',
    )
    err.expected = Number(declared)
    err.length = total
    throw err
  }

  req.complete = true

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * Node's `TextDecoder` treats the bare `utf-16` label as an alias for `utf-16le` and never sniffs the byte-order mark, unlike browsers. Resolve the BOM ourselves so a big-endian payload (`FE FF`) decodes correctly instead of coming out garbled.
 */
function resolveDecoderCharset(charset: string, bytes: Uint8Array): string {
  if (charset !== 'utf-16' && charset !== 'utf16') return charset
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  return 'utf-16le'
}

function decode(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(resolveDecoderCharset(charset, bytes)).decode(bytes)
  } catch {
    const err = new BodyError(
      415,
      'charset.unsupported',
      `unsupported charset "${charset.toUpperCase()}"`,
    )
    err.charset = charset
    throw err
  }
}

function isSupportedCharset(charset: string): boolean {
  try {
    new TextDecoder(charset)
    return true
  } catch {
    return false
  }
}

function makeParser(
  defaultType: TypeOption,
  options: BodyOptions,
  parse: (bytes: Uint8Array, charset: string) => unknown,
  emptyValue: () => unknown,
  isValidCharset: (charset: string) => boolean = isSupportedCharset,
): RequestHandler {
  if (options.verify !== undefined && typeof options.verify !== 'function') {
    throw new TypeError('option verify must be function')
  }

  const limit = parseLimit(options.limit)
  const wanted = options.type ?? defaultType
  const inflate = options.inflate ?? true
  const defaultCharset = (options.defaultCharset ?? 'utf-8').toLowerCase()
  // Express 4's body-parser always initializes req.body to an empty value up front, even when the content-type doesn't match and nothing actually gets parsed. Express 5's newer body-parser dependency only sets it once parsing actually happens, leaving req.body untouched (usually undefined) otherwise.
  const compat = options.compat ?? '5'

  return (req: ExpRequest, res: ExpResponse, next: NextFunction) => {
    if (req.body !== undefined) {
      next()
      return
    }
    if (hasNoBody(req)) {
      req.body = emptyValue()
      next()
      return
    }
    if (!typeMatches(req, wanted)) {
      // body-parser's own default is the plain `req.body = req.body || {}` set before even this check runs -- not the parser-specific empty value (an empty Buffer for raw(), '' for text()) -- so express.raw()/text() skipping a mismatched type still leaves req.body as {}, same as json()/urlencoded().
      if (compat === '4') req.body = {}
      next()
      return
    }

    const charset = charsetOf(req) || defaultCharset

    // Checked ahead of reading the body (and, in particular, ahead of `verify`) so a request with an unsupported charset never reaches user code at all.
    if (!isValidCharset(charset)) {
      const err = new BodyError(
        415,
        'charset.unsupported',
        `unsupported charset "${charset.toUpperCase()}"`,
      )
      err.charset = charset
      next(err)
      return
    }

    readBytes(req, limit, inflate)
      .then((rawBytes) => {
        // Express hands a real Node `Buffer` to `verify` and to `express.raw()`'s result;
        // code that checks `Buffer.isBuffer(req.body)` would otherwise see a plain
        // `Uint8Array` and treat it as unrecognized.
        const bytes = toBuffer(rawBytes)
        runVerify(options.verify, req, res, bytes, charset)
        req.body = bytes.byteLength === 0 ? emptyValue() : parse(bytes, charset)
        next()
      })
      .catch(next)
  }
}

interface VerifyFailure {
  status?: number
  statusCode?: number
  type?: string
  body?: unknown
}

/** A thrown `verify` error becomes a 403 with `entity.verify.failed`, unless it says otherwise. */
function runVerify(
  verify: BodyOptions['verify'],
  req: ExpRequest,
  res: ExpResponse,
  bytes: Uint8Array,
  charset: string,
): void {
  if (!verify) return
  try {
    verify(req, res, bytes, charset)
  } catch (e) {
    const err = e as VerifyFailure
    err.status = err.status ?? err.statusCode ?? 403
    err.statusCode = err.status
    err.type = err.type ?? 'entity.verify.failed'
    err.body = err.body ?? bytes
    throw err
  }
}

interface BufferLike {
  from(buffer: ArrayBufferLike, byteOffset: number, length: number): Uint8Array
}

/** On Node and Bun, wraps the bytes in a real `Buffer` with no copy; elsewhere a no-op. */
function toBuffer(bytes: Uint8Array): Uint8Array {
  const ctor = (globalThis as { Buffer?: BufferLike }).Buffer
  return ctor ? ctor.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : bytes
}

const FIRST_NON_WHITESPACE = /^[ \t\n\r]*([^ \t\n\r])/

function firstNonWhitespaceChar(text: string): string | undefined {
  return FIRST_NON_WHITESPACE.exec(text)?.[1]
}

/**
 * Builds the same error `JSON.parse` itself would raise for a bare primitive like `true`, even though that primitive parses fine on its own — strict mode rejects it only because it isn't wrapped in `{}`/`[]`. Replacing everything after the first real character with `#` (a token `JSON.parse` always rejects) reuses V8's own message instead of inventing one.
 */
function jsonStrictSyntaxError(text: string, firstChar: string | undefined): BodyError {
  const index = text.indexOf(String(firstChar))
  const partial = index === -1 ? '' : text.slice(0, index) + '#'.repeat(text.length - index)
  try {
    JSON.parse(partial)
  } catch (e) {
    const message = (e as Error).message.replace(/#+/g, (placeholder) =>
      text.slice(index, index + placeholder.length),
    )
    const err = new BodyError(400, 'entity.parse.failed', message)
    err.body = text
    return err
  }
  const err = new BodyError(400, 'entity.parse.failed', `Unexpected token ${firstChar}`)
  err.body = text
  return err
}

export function json(options?: BodyOptions): RequestHandler {
  const opts = options ?? {}
  const strict = opts.strict ?? true
  return makeParser(
    'application/json',
    opts,
    (bytes, charset) => {
      const text = decode(bytes, charset)
      if (strict) {
        const first = firstNonWhitespaceChar(text)
        if (first !== '{' && first !== '[') throw jsonStrictSyntaxError(text, first)
      }
      try {
        return JSON.parse(text)
      } catch (e) {
        const err = new BodyError(400, 'entity.parse.failed', (e as Error).message)
        err.body = text
        throw err
      }
    },
    () => ({}),
    (charset) => charset.startsWith('utf-'),
  )
}

export function text(options?: BodyOptions): RequestHandler {
  return makeParser(
    'text/plain',
    options ?? {},
    (bytes, charset) => decode(bytes, charset),
    () => '',
  )
}

export function raw(options?: BodyOptions): RequestHandler {
  return makeParser(
    'application/octet-stream',
    options ?? {},
    (bytes) => bytes,
    () => toBuffer(new Uint8Array(0)),
    // Raw bodies are never decoded, so a charset on the request is irrelevant here.
    () => true,
  )
}

export function urlencoded(options?: BodyOptions): RequestHandler {
  const opts = options ?? {}
  const extended = opts.extended ?? false
  const parameterLimit = opts.parameterLimit ?? 1000
  if (typeof parameterLimit !== 'number' || Number.isNaN(parameterLimit) || parameterLimit <= 0) {
    throw new TypeError('option parameterLimit must be a positive number')
  }
  return makeParser(
    'application/x-www-form-urlencoded',
    opts,
    (bytes, charset) => parseUrlencoded(decode(bytes, charset), extended, parameterLimit),
    () => ({}),
    (charset) => charset === 'utf-8' || charset === 'iso-8859-1',
  )
}

/**
 * Parses application/x-www-form-urlencoded.
 *
 * `extended: false` behaves like querystring.parse (repeated keys become arrays); `extended: true` also understands `a[b]=1` and `a[]=1`, and folds an object with consecutive numeric keys back into an array afterwards, matching the `qs` package. Both reject prototype-polluting keys.
 */
export function parseUrlencoded(
  input: string,
  extended: boolean,
  parameterLimit = Number.POSITIVE_INFINITY,
): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null)
  if (input.length === 0) return out

  let count = 0
  for (const [rawKey, value] of new URLSearchParams(input)) {
    count++
    if (count > parameterLimit) {
      throw new BodyError(413, 'parameters.too.many', 'too many parameters')
    }
    if (isUnsafeKey(rawKey)) continue
    if (!extended) {
      assign(out, rawKey, value)
      continue
    }
    const path = parseBracketPath(rawKey)
    if (path.some(isUnsafeKey)) continue
    assignDeep(out, path, value)
  }
  return extended ? (compactArrays(out) as Record<string, unknown>) : out
}

/** Recursively turns an object whose keys are exactly `0, 1, 2, ...` into a real array. */
function compactArrays(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj)
  for (const key of keys) obj[key] = compactArrays(obj[key])
  if (keys.length > 0 && keys.every((key, i) => key === String(i))) {
    return keys.map((key) => obj[key])
  }
  return obj
}

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype'])

function isUnsafeKey(key: string): boolean {
  return UNSAFE.has(key)
}

function assign(target: Record<string, unknown>, key: string, value: string): void {
  const existing = target[key]
  if (existing === undefined) target[key] = value
  else if (Array.isArray(existing)) existing.push(value)
  else target[key] = [existing, value]
}

/** `a[b][c]` becomes `['a','b','c']`; `c[]` becomes `['c','']`. */
function parseBracketPath(key: string): string[] {
  const open = key.indexOf('[')
  if (open === -1) return [key]
  const parts: string[] = [key.slice(0, open)]
  const rest = key.slice(open)
  const re = /\[([^\]]*)\]/g
  let m = re.exec(rest)
  while (m) {
    parts.push(m[1] as string)
    m = re.exec(rest)
  }
  return parts
}

/**
 * `foo[]` (an empty bracket) means "the next index in this node", not a literal key —
 * `compactArrays` later turns a node holding only `0, 1, 2, ...` back into an array.
 */
function resolveArrayKey(node: Record<string, unknown>, key: string): string {
  if (key !== '') return key
  let index = 0
  while (Object.hasOwn(node, String(index))) index++
  return String(index)
}

function assignDeep(root: Record<string, unknown>, path: string[], value: string): void {
  let node: Record<string, unknown> = root
  for (let i = 0; i < path.length - 1; i++) {
    const key = resolveArrayKey(node, path[i] as string)
    const next = node[key]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      node[key] = Object.create(null) as Record<string, unknown>
    }
    node = node[key] as Record<string, unknown>
  }

  const lastKey = resolveArrayKey(node, path[path.length - 1] as string)
  assign(node, lastKey, value)
}
