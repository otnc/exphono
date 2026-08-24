/**
 * Built-in body parsers.
 *
 * Written from scratch rather than wrapping body-parser: it assumes Node streams, and
 * reading the Fetch Request directly is cheaper. Using the real body-parser still works,
 * since `req` keeps its Node stream surface.
 */

import { kState } from '../object-model.js'
import type { ExpRequest } from '../request.js'
import type { ExpResponse } from '../response.js'
import type { NextFunction, RequestHandler } from '../router/index.js'

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
  /** JSON only: only accept objects and arrays at the top level. */
  strict?: boolean
  /** Charset assumed when the request does not name one. */
  defaultCharset?: string
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
    const w = want.toLowerCase()
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
 * The headers alone are not enough: a Request built in-process and handed straight to
 * `app.fetch()` has a body stream but no content-length.
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
    if (!inflate || !INFLATABLE.has(encoding)) {
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

function decode(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset).decode(bytes)
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

function makeParser(
  defaultType: TypeOption,
  options: BodyOptions,
  parse: (bytes: Uint8Array, charset: string) => unknown,
  emptyValue: () => unknown,
): RequestHandler {
  const limit = parseLimit(options.limit)
  const wanted = options.type ?? defaultType
  const inflate = options.inflate ?? true
  const defaultCharset = (options.defaultCharset ?? 'utf-8').toLowerCase()

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
      next()
      return
    }

    const charset = charsetOf(req) || defaultCharset

    readBytes(req, limit, inflate)
      .then((bytes) => {
        options.verify?.(req, res, bytes, charset)
        req.body = bytes.byteLength === 0 ? emptyValue() : parse(bytes, charset)
        next()
      })
      .catch(next)
  }
}

export function json(options: BodyOptions = {}): RequestHandler {
  const strict = options.strict ?? true
  return makeParser(
    'application/json',
    options,
    (bytes, charset) => {
      const text = decode(bytes, charset)
      const first = text.trimStart().charAt(0)
      if (strict && first !== '{' && first !== '[') {
        const err = new BodyError(400, 'entity.parse.failed', `Unexpected token ${first}`)
        err.body = text
        throw err
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
  )
}

export function text(options: BodyOptions = {}): RequestHandler {
  return makeParser(
    'text/plain',
    options,
    (bytes, charset) => decode(bytes, charset),
    () => '',
  )
}

export function raw(options: BodyOptions = {}): RequestHandler {
  return makeParser(
    'application/octet-stream',
    options,
    (bytes) => bytes,
    () => new Uint8Array(0),
  )
}

export function urlencoded(options: BodyOptions = {}): RequestHandler {
  const extended = options.extended ?? false
  return makeParser(
    'application/x-www-form-urlencoded',
    options,
    (bytes, charset) => parseUrlencoded(decode(bytes, charset), extended),
    () => ({}),
  )
}

/**
 * Parses application/x-www-form-urlencoded.
 *
 * `extended: false` behaves like querystring.parse (repeated keys become arrays);
 * `extended: true` also understands `a[b]=1`. Both reject prototype-polluting keys.
 */
export function parseUrlencoded(input: string, extended: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = Object.create(null)
  if (input.length === 0) return out

  for (const [rawKey, value] of new URLSearchParams(input)) {
    if (isUnsafeKey(rawKey)) continue
    if (!extended) {
      assign(out, rawKey, value)
      continue
    }
    const path = parseBracketPath(rawKey)
    if (path.some(isUnsafeKey)) continue
    assignDeep(out, path, value)
  }
  return out
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

function assignDeep(root: Record<string, unknown>, path: string[], value: string): void {
  // `c[]=1&c[]=2` ends in an empty key: treat the parent as an array
  const pushToArray = path[path.length - 1] === ''
  const keys = pushToArray ? path.slice(0, -1) : path

  let node: Record<string, unknown> = root
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i] as string
    const next = node[key]
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      node[key] = Object.create(null) as Record<string, unknown>
    }
    node = node[key] as Record<string, unknown>
  }

  const last = keys[keys.length - 1] as string
  if (pushToArray) {
    const existing = node[last]
    if (Array.isArray(existing)) existing.push(value)
    else node[last] = [value]
    return
  }
  assign(node, last, value)
}
