/**
 * File serving shared by `res.sendFile`, `res.download` and `express.static`.
 *
 * Reimplemented rather than reusing the `send` package, which is built around Node's
 * http module.
 */

import type { ExpRequest } from '../request.js'
import type { ExpResponse } from '../response.js'
import {
  extname,
  type FileStat,
  hasFileSystem,
  isAbsolutePath,
  joinPath,
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
  headers?: (res: ExpResponse, path: string, stat: FileStat) => void
}

export class SendError extends Error {
  status: number
  statusCode: number
  code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'SendError'
    this.status = status
    this.statusCode = status
    this.code = code
  }
}

function parseMaxAge(value: number | string | undefined): number {
  if (value === undefined) return 0
  if (typeof value === 'number') return Math.floor(value / 1000)
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|y)?$/i.exec(value.trim())
  if (!m) return 0
  const n = Number(m[1])
  const unit = (m[2] ?? 'ms').toLowerCase()
  const seconds =
    unit === 'ms'
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
  return Math.floor(seconds)
}

/** A weak ETag; the exact bytes differ from Express but the semantics are the same. */
function weakEtag(stat: FileStat): string {
  return `W/"${stat.size.toString(16)}-${stat.mtime.getTime().toString(16)}"`
}

function containsDotfile(path: string): boolean {
  return path.split('/').some((part) => part.length > 1 && part.startsWith('.'))
}

/**
 * Resolves the request path against `root`, refusing anything that escapes it.
 *
 * Without a root the path must already be absolute, which is what `res.sendFile` requires.
 */
async function resolveTarget(path: string, root: string | undefined): Promise<string> {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    throw new SendError(400, 'failed to decode path')
  }
  if (decoded.includes('\0')) throw new SendError(400, 'bad request')

  if (root === undefined) {
    if (!(await isAbsolutePath(decoded))) {
      throw new TypeError('path must be absolute or specify root to res.sendFile')
    }
    return decoded
  }

  const base = await resolvePath(root)
  const full = await resolvePath(await joinPath(base, decoded))
  if (full !== base && !full.startsWith(`${base}/`) && !full.startsWith(`${base}\\`)) {
    throw new SendError(403, 'Forbidden')
  }
  return full
}

/** Finds the file to serve, following `index` and `extensions`. */
async function locate(target: string, options: SendOptions): Promise<[string, FileStat]> {
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
    if (options.index === false) throw new SendError(404, 'Not Found', 'ENOENT')
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

  const dotfiles = options.dotfiles ?? 'ignore'
  if (dotfiles !== 'allow' && containsDotfile(urlPath)) {
    throw new SendError(
      dotfiles === 'deny' ? 403 : 404,
      dotfiles === 'deny' ? 'Forbidden' : 'Not Found',
    )
  }

  const target = await resolveTarget(urlPath, options.root)
  const [file, stat] = await locate(target, options)

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

  options.headers?.(res, file, stat)

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
    throw new SendError(416, 'Range Not Satisfiable')
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
