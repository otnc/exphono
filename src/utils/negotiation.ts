/**
 * Content negotiation and conditional requests.
 *
 * Reimplemented instead of pulling in accepts / negotiator / type-is / fresh /
 * range-parser, which are Node-bound and large.
 */

interface Spec {
  value: string
  quality: number
  index: number
}

/** Parses an Accept-style header, best quality first. */
function parseAcceptHeader(header: string | undefined): Spec[] {
  if (!header) return []
  const out: Spec[] = []
  header.split(',').forEach((part, index) => {
    const trimmed = part.trim()
    if (!trimmed) return
    const [value, ...params] = trimmed.split(';')
    let quality = 1
    for (const p of params) {
      const m = /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(p)
      if (m) quality = Number.parseFloat(m[1] as string)
    }
    out.push({ value: (value as string).trim().toLowerCase(), quality, index })
  })
  return out.filter((s) => s.quality > 0).sort((a, b) => b.quality - a.quality || a.index - b.index)
}

function normalizeType(type: string): string {
  if (type.includes('/')) return type.toLowerCase()
  return (MIME_BY_EXT[type.replace(/^\./, '').toLowerCase()] ?? '').toLowerCase()
}

const MIME_BY_EXT: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  text: 'text/plain',
  json: 'application/json',
  js: 'text/javascript',
  css: 'text/css',
  xml: 'application/xml',
  csv: 'text/csv',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  pdf: 'application/pdf',
  zip: 'application/zip',
  form: 'application/x-www-form-urlencoded',
  urlencoded: 'application/x-www-form-urlencoded',
  multipart: 'multipart/form-data',
  bin: 'application/octet-stream',
}

function typeMatchesSpec(candidate: string, spec: string): boolean {
  if (spec === '*/*') return true
  if (spec === candidate) return true
  const [sType, sSub] = spec.split('/')
  const [cType, cSub] = candidate.split('/')
  if (sSub === '*') return sType === cType
  // Suffixed form, e.g. application/*+json
  if (sSub?.startsWith('*+')) return sType === cType && Boolean(cSub?.endsWith(sSub.slice(1)))
  return false
}

/** With no types, returns the acceptable types in order. */
export function accepts(header: string | undefined, types: string[]): string | string[] | false {
  const specs = parseAcceptHeader(header ?? '*/*')
  if (types.length === 0) return specs.map((s) => s.value)
  if (specs.length === 0) return types[0] as string

  for (const spec of specs) {
    for (const type of types) {
      const normalized = normalizeType(type)
      if (normalized && typeMatchesSpec(normalized, spec.value)) return type
    }
  }
  return false
}

/** Shared by acceptsCharsets / acceptsEncodings / acceptsLanguages. */
export function acceptsSimple(
  header: string | undefined,
  values: string[],
  fallback: string | undefined,
): string | string[] | false {
  const specs = parseAcceptHeader(header)
  if (specs.length === 0) {
    // No header means anything goes
    if (values.length === 0) return fallback ? [fallback] : []
    return values[0] as string
  }
  if (values.length === 0) return specs.map((s) => s.value)

  for (const spec of specs) {
    for (const value of values) {
      const v = value.toLowerCase()
      if (spec.value === '*' || spec.value === v) return value
      // 'en' matches 'en-US'
      if (v.startsWith(`${spec.value}-`)) return value
    }
  }
  // identity is acceptable unless explicitly refused
  if (fallback && values.some((v) => v.toLowerCase() === fallback)) {
    const denied = specs.some((s) => s.value === fallback || s.value === '*')
    if (!denied) return fallback
  }
  return false
}

/** Backs `req.is(type)`. */
export function isType(contentType: string | undefined, types: string[]): string | false | null {
  if (!contentType) return null
  const actual = contentType.split(';')[0]?.trim().toLowerCase() ?? ''
  if (!actual) return null
  if (types.length === 0) return actual

  for (const type of types) {
    const t = type.toLowerCase()
    if (t === '*/*') return actual
    if (t.startsWith('+')) {
      // Suffix form, e.g. '+json'
      if (actual.endsWith(t)) return actual
      continue
    }
    const normalized = normalizeType(type) || t
    if (typeMatchesSpec(actual, normalized)) return type
  }
  return false
}

/**
 * True when the cached copy is still fresh, i.e. a 304 may be returned.
 */
export function isFresh(
  reqHeaders: {
    'if-none-match'?: string
    'if-modified-since'?: string
    'cache-control'?: string
  },
  resHeaders: { etag?: string; 'last-modified'?: string },
): boolean {
  const noneMatch = reqHeaders['if-none-match']
  const modifiedSince = reqHeaders['if-modified-since']
  if (!noneMatch && !modifiedSince) return false

  const cacheControl = reqHeaders['cache-control']
  if (cacheControl && /(?:^|,)\s*no-cache\s*(?:,|$)/.test(cacheControl)) return false

  if (noneMatch) {
    if (noneMatch === '*') return true
    const etag = resHeaders.etag
    if (!etag) return false
    const candidates = noneMatch.split(',').map((s) => s.trim())
    const weakless = (v: string) => (v.startsWith('W/') ? v.slice(2) : v)
    if (!candidates.some((c) => c === etag || weakless(c) === weakless(etag))) return false
  }

  if (modifiedSince) {
    const lastModified = resHeaders['last-modified']
    if (!lastModified) return false
    const a = Date.parse(lastModified)
    const b = Date.parse(modifiedSince)
    if (Number.isNaN(a) || Number.isNaN(b) || a > b) return false
  }

  return true
}

export interface RangeResult extends Array<{ start: number; end: number }> {
  type: string
}

/** Backs `req.range(size)`. Returns -1 for an unsatisfiable range, -2 for a malformed one. */
export function parseRange(
  size: number,
  header: string | undefined,
  options?: { combine?: boolean },
): RangeResult | -1 | -2 | undefined {
  if (!header) return undefined
  const index = header.indexOf('=')
  if (index === -1) return -2

  const type = header.slice(0, index)
  const ranges: { start: number; end: number }[] = []

  for (const part of header.slice(index + 1).split(',')) {
    const [rawStart, rawEnd] = part.split('-')
    let start = Number.parseInt(rawStart as string, 10)
    let end = Number.parseInt(rawEnd as string, 10)

    if (Number.isNaN(start)) {
      // '-500' means the last 500 bytes
      start = size - end
      end = size - 1
    } else if (Number.isNaN(end)) {
      end = size - 1
    }
    if (end > size - 1) end = size - 1
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0) continue
    ranges.push({ start, end })
  }

  if (ranges.length === 0) return -1

  const result = (options?.combine ? combineRanges(ranges) : ranges) as RangeResult
  result.type = type
  return result
}

function combineRanges(ranges: { start: number; end: number }[]): { start: number; end: number }[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const out: { start: number; end: number }[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}
