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

export interface BodyOptions {
  /** Content types to accept. */
  type?: string | string[]
  /** Byte limit, as a number or '100kb'. */
  limit?: number | string
  /** urlencoded only: parse nested keys. */
  extended?: boolean
  /** JSON only: require the body to start with `{` or `[`. */
  strict?: boolean
  /** text only: character encoding. */
  defaultCharset?: string
}

const DEFAULT_LIMIT = 100 * 1024

function parseLimit(limit: number | string | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT
  if (typeof limit === 'number') return limit
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/i.exec(limit.trim())
  if (!m) return DEFAULT_LIMIT
  const n = Number(m[1])
  const unit = (m[2] ?? 'b').toLowerCase()
  const mult = unit === 'kb' ? 1024 : unit === 'mb' ? 1024 ** 2 : unit === 'gb' ? 1024 ** 3 : 1
  return Math.round(n * mult)
}

function contentTypeOf(req: ExpRequest): string {
  const v = req.get('content-type')
  return (typeof v === 'string' ? v : '').split(';')[0]?.trim().toLowerCase() ?? ''
}

function typeMatches(actual: string, expected: string | string[]): boolean {
  const list = Array.isArray(expected) ? expected : [expected]
  return list.some((want) => {
    const w = want.toLowerCase()
    if (w === actual) return true
    if (w.endsWith('/*')) return actual.startsWith(`${w.slice(0, -1)}`)
    if (w === '*/*') return true
    // Suffix form, e.g. '+json'
    if (w.startsWith('+')) return actual.endsWith(w)
    return false
  })
}

/** Methods that carry no body. */
function hasNoBody(req: ExpRequest): boolean {
  return req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE'
}

class PayloadTooLargeError extends Error {
  status = 413
  statusCode = 413
  type = 'entity.too.large'
  constructor(limit: number) {
    super(`request entity too large (limit: ${limit} bytes)`)
    this.name = 'PayloadTooLargeError'
  }
}

class BadRequestError extends Error {
  status = 400
  statusCode = 400
  type = 'entity.parse.failed'
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

async function readBytes(req: ExpRequest, limit: number): Promise<Uint8Array> {
  const raw = req[kState].ctx.req.raw
  const declared = req.get('content-length')
  if (typeof declared === 'string' && Number(declared) > limit) {
    throw new PayloadTooLargeError(limit)
  }
  const buf = new Uint8Array(await raw.arrayBuffer())
  if (buf.byteLength > limit) throw new PayloadTooLargeError(limit)
  req.complete = true
  return buf
}

function makeParser(
  defaultType: string | string[],
  options: BodyOptions,
  parse: (bytes: Uint8Array, req: ExpRequest) => unknown,
): RequestHandler {
  const limit = parseLimit(options.limit)
  const wanted = options.type ?? defaultType

  return (req: ExpRequest, _res: ExpResponse, next: NextFunction) => {
    if (req.body !== undefined) return next()
    if (hasNoBody(req)) {
      req.body = emptyBodyFor(defaultType)
      return next()
    }
    if (!typeMatches(contentTypeOf(req), wanted)) return next()

    readBytes(req, limit)
      .then((bytes) => {
        req.body = parse(bytes, req)
        next()
      })
      .catch(next)
  }
}

function emptyBodyFor(type: string | string[]): unknown {
  const t = Array.isArray(type) ? type[0] : type
  if (t === 'application/json' || t === 'application/x-www-form-urlencoded') return {}
  return undefined
}

const decoder = new TextDecoder()

export function json(options: BodyOptions = {}): RequestHandler {
  const strict = options.strict ?? true
  return makeParser('application/json', options, (bytes) => {
    if (bytes.byteLength === 0) return {}
    const text = decoder.decode(bytes)
    if (strict) {
      const first = text.trimStart()[0]
      if (first !== '{' && first !== '[') {
        throw new BadRequestError('Unexpected token in JSON body')
      }
    }
    try {
      return JSON.parse(text)
    } catch (e) {
      throw new BadRequestError((e as Error).message)
    }
  })
}

export function text(options: BodyOptions = {}): RequestHandler {
  return makeParser('text/plain', options, (bytes) => decoder.decode(bytes))
}

export function raw(options: BodyOptions = {}): RequestHandler {
  return makeParser('application/octet-stream', options, (bytes) => bytes)
}

export function urlencoded(options: BodyOptions = {}): RequestHandler {
  const extended = options.extended ?? false
  return makeParser('application/x-www-form-urlencoded', options, (bytes) => {
    const text = decoder.decode(bytes)
    return parseUrlencoded(text, extended)
  })
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

  const params = new URLSearchParams(input)
  for (const [rawKey, value] of params) {
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

/** `a[b][c]` → `['a','b','c']` / `c[]` → `['c','']` */
function parseBracketPath(key: string): string[] {
  const open = key.indexOf('[')
  if (open === -1) return [key]
  const head = key.slice(0, open)
  const rest = key.slice(open)
  const parts: string[] = [head]
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
