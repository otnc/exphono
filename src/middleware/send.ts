/**
 * File serving shared by `res.sendFile`, `res.download` and `express.static`.
 *
 * Reimplemented rather than reusing the `send` package, which is built around Node's http module.
 */

import type { ExpRequest } from '../request.js'
import type { ExpResponse } from '../response.js'
import {
  extname,
  type FileStat,
  hasFileSystem,
  isAbsolutePath,
  joinPath,
  normalizePath,
  readFileStream,
  resolvePath,
  statFile,
} from '../runtime/files.js'
import { lookupMimeType } from '../utils/mime.js'
import { isFresh, parseRange } from '../utils/negotiation.js'

export interface SendOptions {
  root?: string
  /** 'allow' serves them, 'deny' returns 403, 'ignore' returns 404. */
  dotfiles?: 'allow' | 'deny' | 'ignore'
  /** Directory index file names, or false to disable. */
  index?: string | string[] | false
  /** Extensions to try when the exact path is missing. */
  extensions?: string | string[] | false
  maxAge?: number | string
  immutable?: boolean
  cacheControl?: boolean
  lastModified?: boolean
  etag?: boolean
  acceptRanges?: boolean
  /** Called once the file to serve is known, before headers are written. Express's `express.static({ setHeaders })`. */
  setHeaders?: (res: ExpResponse, path: string, stat: FileStat) => void
  /** A plain header map applied unconditionally on success. Express's `res.sendFile`/`res.download` `{ headers }`. */
  headers?: Record<string, string>
}

export class SendError extends Error {
  status: number
  statusCode: number
  code?: string
  /**
   * Set when the target turned out to be a directory that could not be served as an index
   * (no trailing slash, or indexes disabled). `express.static` turns this into a redirect
   * to the trailing-slash form; `res.sendFile`/`res.download` just leave it as a 404.
   */
  isDirectory?: boolean
  /**
   * Set once a matching file has actually been found. `express.static`'s `fallthrough`
   * option only covers "this doesn't look like one of my files" (not found, forbidden,
   * a bare directory); an error raised while building the response for a file that does
   * exist (a failed precondition, an invalid range) is always reported, never swallowed.
   */
  fileFound?: boolean

  constructor(status: number, message: string, code?: string, isDirectory?: boolean) {
    super(message)
    // Matches the `http-errors` naming convention (`404` -> `NotFoundError`), since the
    // default error page shows the error's name and a few express tests check for it.
    this.name = HTTP_ERROR_NAMES[status] ?? 'SendError'
    this.status = status
    this.statusCode = status
    this.code = code
    this.isDirectory = isDirectory
  }
}

const HTTP_ERROR_NAMES: Record<number, string> = {
  400: 'BadRequestError',
  403: 'ForbiddenError',
  404: 'NotFoundError',
  405: 'MethodNotAllowedError',
  412: 'PreconditionFailedError',
  416: 'RangeNotSatisfiableError',
  500: 'InternalServerError',
}

/** A `SendError` for a problem discovered after the target file was already found. */
function fileFoundError(status: number, message: string): SendError {
  const err = new SendError(status, message)
  err.fileFound = true
  return err
}

/** One year in seconds, matching the `send` package's `MAX_MAXAGE` clamp. */
const MAX_MAXAGE_SECONDS = 60 * 60 * 24 * 365

function parseMaxAge(value: number | string | undefined): number {
  if (value === undefined) return 0
  const seconds = typeof value === 'number' ? value / 1000 : parseMaxAgeString(value)
  if (Number.isNaN(seconds)) return 0
  return Math.floor(Math.min(Math.max(0, seconds), MAX_MAXAGE_SECONDS))
}

function parseMaxAgeString(value: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|y)?$/i.exec(value.trim())
  if (!m) return Number.NaN
  const n = Number(m[1])
  const unit = (m[2] ?? 'ms').toLowerCase()
  return unit === 'ms'
    ? n / 1000
    : unit === 's'
      ? n
      : unit === 'm'
        ? n * 60
        : unit === 'h'
          ? n * 3600
          : unit === 'd'
            ? n * 86400
            : n * 31536000
}

/** A weak ETag; the exact bytes differ from Express but the semantics are the same. */
function weakEtag(stat: FileStat): string {
  return `W/"${stat.size.toString(16)}-${stat.mtime.getTime().toString(16)}"`
}

/** `If-Match` / `If-Unmodified-Since`, checked ahead of the `304` freshness check. */
function isPreconditionFailure(
  ifMatch: string | undefined,
  ifUnmodifiedSince: string | undefined,
  etag: string | undefined,
  lastModified: string | undefined,
): boolean {
  if (ifMatch !== undefined) {
    if (!etag) return true
    if (ifMatch === '*') return false
    const tokens = ifMatch.split(',').map((t) => t.trim())
    return tokens.every((token) => token !== etag && token !== `W/${etag}` && `W/${token}` !== etag)
  }

  const unmodifiedSince = Date.parse(ifUnmodifiedSince ?? '')
  if (!Number.isNaN(unmodifiedSince)) {
    const modified = Date.parse(lastModified ?? '')
    return Number.isNaN(modified) || modified > unmodifiedSince
  }

  return false
}

function containsDotfile(path: string): boolean {
  return path.split(/[/\\]/).some((part) => part.startsWith('.') && part !== '.' && part !== '..')
}

/**
 * A leading, trailing or standalone `..` path segment. Matches the `send` package's
 * `UP_PATH_REGEXP`: a path is rejected whenever this appears, even if the segment would
 * ultimately resolve back inside `root` once joined.
 */
const UP_PATH_REGEXP = /(?:^|[\\/])\.\.(?:[\\/]|$)/

/**
 * Resolves the request path against `root`, refusing anything that escapes it.
 *
 * Without a root the path must already be absolute, which is what `res.sendFile` requires.
 */
async function resolveTarget(
  path: string,
  root: string | undefined,
  dotfiles: 'allow' | 'deny' | 'ignore',
): Promise<string> {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    throw new SendError(400, 'failed to decode path')
  }
  if (decoded.includes('\0')) throw new SendError(400, 'bad request')

  if (root === undefined) {
    if (UP_PATH_REGEXP.test(decoded)) throw new SendError(403, 'Forbidden')
    checkDotfile(decoded, dotfiles)
    if (!(await isAbsolutePath(decoded))) {
      throw new TypeError('path must be absolute or specify root to res.sendFile')
    }
    return decoded
  }

  const normalized = decoded ? await normalizePath(`./${decoded}`) : ''
  if (UP_PATH_REGEXP.test(normalized)) throw new SendError(403, 'Forbidden')
  checkDotfile(normalized, dotfiles)

  const base = await resolvePath(root)
  return resolvePath(await joinPath(base, normalized))
}

function checkDotfile(path: string, dotfiles: 'allow' | 'deny' | 'ignore'): void {
  if (dotfiles === 'allow' || !containsDotfile(path)) return
  throw new SendError(
    dotfiles === 'deny' ? 403 : 404,
    dotfiles === 'deny' ? 'Forbidden' : 'Not Found',
  )
}

/**
 * Finds the file to serve, following `index` and `extensions`.
 *
 * `hasTrailingSlash` mirrors the `send` package's `hasTrailingSlash()` gate: a directory is
 * only auto-served as its index file when the original request path ended with `/`.
 */
async function locate(
  target: string,
  options: SendOptions,
  hasTrailingSlash: boolean,
): Promise<[string, FileStat]> {
  const stat = await statFile(target)

  if (!stat && options.extensions) {
    const list = Array.isArray(options.extensions) ? options.extensions : [options.extensions]
    for (const ext of list) {
      const candidate = `${target}.${String(ext).replace(/^\./, '')}`
      const s = await statFile(candidate)
      if (s?.isFile) return [candidate, s]
    }
  }

  if (!stat) throw new SendError(404, 'Not Found', 'ENOENT')

  if (stat.isDirectory) {
    if (options.index === false || !hasTrailingSlash) {
      throw new SendError(404, 'Not Found', 'ENOENT', true)
    }
    const names =
      options.index === undefined
        ? ['index.html']
        : Array.isArray(options.index)
          ? options.index
          : [options.index]
    for (const name of names) {
      const candidate = await joinPath(target, name)
      const s = await statFile(candidate)
      if (s?.isFile) return [candidate, s]
    }
    throw new SendError(404, 'Not Found', 'ENOENT')
  }

  // A trailing slash on a path that resolves to a plain file (e.g. mounting a file
  // directly and requesting it with `/`) has no file to serve.
  if (hasTrailingSlash) throw new SendError(404, 'Not Found', 'ENOENT')

  return [target, stat]
}

/**
 * Serves a file, honouring conditional requests and range requests.
 *
 * `urlPath` is the request-relative path; `options.root` bounds it.
 */
export async function sendFile(
  req: ExpRequest,
  res: ExpResponse,
  urlPath: string,
  options: SendOptions = {},
): Promise<void> {
  if (!hasFileSystem) throw new SendError(500, 'no filesystem on this runtime')

  const target = await resolveTarget(urlPath, options.root, options.dotfiles ?? 'ignore')
  const [file, stat] = await locate(target, options, urlPath.endsWith('/'))

  if (!res.get('content-type')) {
    const type = lookupMimeType((await extname(file)).replace(/^\./, ''))
    res.type(type)
  }

  if (options.acceptRanges !== false) res.set('accept-ranges', 'bytes')
  if (options.lastModified !== false) res.set('last-modified', stat.mtime.toUTCString())
  if (options.etag !== false) res.set('etag', weakEtag(stat))

  if (options.cacheControl !== false) {
    const parts = [`public, max-age=${parseMaxAge(options.maxAge)}`]
    if (options.immutable) parts.push('immutable')
    res.set('cache-control', parts.join(', '))
  }

  options.setHeaders?.(res, file, stat)
  if (options.headers) {
    // `res.setHeader`, not `res.set`: Express applies this option with the low-level
    // Node API, which skips the automatic charset that `res.set('Content-Type', ...)`
    // would otherwise add.
    for (const [key, value] of Object.entries(options.headers)) res.setHeader(key, value)
  }

  const ifMatch = asString(req.get('if-match'))
  const ifUnmodifiedSince = asString(req.get('if-unmodified-since'))

  if (ifMatch !== undefined || ifUnmodifiedSince !== undefined) {
    if (
      isPreconditionFailure(ifMatch, ifUnmodifiedSince, res.get('etag'), res.get('last-modified'))
    ) {
      throw fileFoundError(412, 'Precondition Failed')
    }
  }

  if (
    isFresh(
      {
        'if-none-match': asString(req.get('if-none-match')),
        'if-modified-since': asString(req.get('if-modified-since')),
        'cache-control': asString(req.get('cache-control')),
      },
      { etag: res.get('etag'), 'last-modified': res.get('last-modified') },
    )
  ) {
    res.status(304).end()
    return
  }

  const ranges =
    options.acceptRanges === false ? undefined : parseRange(stat.size, asString(req.get('range')))

  if (ranges === -1) {
    res.set('content-range', `bytes */${stat.size}`)
    throw fileFoundError(416, 'Range Not Satisfiable')
  }

  if (Array.isArray(ranges) && ranges.type === 'bytes' && ranges.length === 1) {
    const { start, end } = ranges[0] as { start: number; end: number }
    res.status(206)
    res.set('content-range', `bytes ${start}-${end}/${stat.size}`)
    res.set('content-length', String(end - start + 1))
    await pipe(res, await readFileStream(file, { start, end }), req.method === 'HEAD')
    return
  }

  res.set('content-length', String(stat.size))
  await pipe(res, await readFileStream(file), req.method === 'HEAD')
}

function asString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

async function pipe(res: ExpResponse, stream: ReadableStream, headOnly: boolean): Promise<void> {
  if (headOnly) {
    res.end()
    return
  }
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    res.write(value)
  }
  res.end()
}
