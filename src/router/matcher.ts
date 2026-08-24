/**
 * Path matching. Express 4 and 5 use different path-to-regexp generations, and this
 * module is the only place that knows the difference.
 *
 *   compat=4 : ':id'  ':id?'  '*'  '/files/*'  inline regular expressions
 *   compat=5 : ':id'  '{/:id}'  '*splat'  (wildcards must be named)
 */

import type { CompatMode } from '../inventory.js'

export type PathSpec = string | RegExp | (string | RegExp)[]

export interface MatchResult {
  params: Record<string, string>
  /** The matched prefix, used to trim `req.url` when mounting. */
  matched: string
}

export interface PathMatcher {
  match(path: string): MatchResult | null
}

export interface MatcherOptions {
  /** Whether to anchor the end; mounts match a prefix instead. */
  end: boolean
  caseSensitive: boolean
  strict: boolean
  compat: CompatMode
}

interface Key {
  name: string
  /** Wildcards swallow multiple segments. */
  wildcard: boolean
}

interface Compiled {
  regexp: RegExp
  keys: Key[]
}

/**
 * Compiles one path.
 *
 * `use('/')` is Express's fast_slash case: it always matches and strips nothing.
 * Without it, `app.use(fn)` never runs.
 */
function compileOne(path: string | RegExp, opts: MatcherOptions): Compiled | 'fast-slash' {
  if (!opts.end && typeof path === 'string' && (path === '/' || path === '')) {
    return 'fast-slash'
  }
  if (path instanceof RegExp) {
    if (opts.compat === '5') {
      // Express 5 rejects inline regular expressions; exphono accepts them anyway
    }
    return { regexp: path, keys: [] }
  }
  return compileString(path, opts)
}

const ESCAPE_RE = /[.+^${}()|[\]\\]/g

function compileString(path: string, opts: MatcherOptions): Compiled {
  const keys: Key[] = []
  let source = ''
  let i = 0
  let anonWildcard = 0

  while (i < path.length) {
    const ch = path[i]

    if (ch === ':') {
      // :name, or :name? under compat=4
      let j = i + 1
      while (j < path.length && /[A-Za-z0-9_]/.test(path[j] as string)) j++
      const name = path.slice(i + 1, j)
      if (name.length === 0) {
        source += '\\:'
        i++
        continue
      }
      const optional = opts.compat === '4' && path[j] === '?'
      keys.push({ name, wildcard: false })
      // Let an optional parameter drop its leading slash too
      if (optional && source.endsWith('/')) {
        source = `${source.slice(0, -1)}(?:/([^/]+?))?`
      } else if (optional) {
        source += '([^/]+?)?'
      } else {
        source += '([^/]+?)'
      }
      i = optional ? j + 1 : j
      continue
    }

    if (ch === '*') {
      // Named under compat=5 ('*splat'), bare under compat=4
      let j = i + 1
      while (j < path.length && /[A-Za-z0-9_]/.test(path[j] as string)) j++
      const name = path.slice(i + 1, j) || String(anonWildcard++)
      keys.push({ name, wildcard: true })
      source += '(.*)'
      i = j
      continue
    }

    if (ch === '{' && opts.compat === '5') {
      // Express 5 optional group, '{/:id}'
      const close = path.indexOf('}', i)
      if (close !== -1) {
        const inner = path.slice(i + 1, close)
        const innerCompiled = compileString(inner, opts)
        keys.push(...innerCompiled.keys)
        source += `(?:${innerCompiled.regexp.source.replace(/^\^/, '').replace(/\$$/, '')})?`
        i = close + 1
        continue
      }
    }

    source += (ch as string).replace(ESCAPE_RE, '\\$&')
    i++
  }

  if (!opts.strict) source += '/?'
  const tail = opts.end ? '$' : '(?=/|$)'
  const flags = opts.caseSensitive ? '' : 'i'
  return { regexp: new RegExp(`^${source}${tail}`, flags), keys }
}

function decodeParam(value: string | undefined): string {
  if (value === undefined) return ''
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

class CompiledMatcher implements PathMatcher {
  #compiled: (Compiled | 'fast-slash')[]

  constructor(compiled: (Compiled | 'fast-slash')[]) {
    this.#compiled = compiled
  }

  match(path: string): MatchResult | null {
    for (const c of this.#compiled) {
      // Always matches and strips nothing
      if (c === 'fast-slash') return { params: {}, matched: '' }

      const m = c.regexp.exec(path)
      if (!m) continue
      const params: Record<string, string> = {}
      c.keys.forEach((key, idx) => {
        const raw = m[idx + 1]
        if (raw !== undefined) params[key.name] = decodeParam(raw)
      })
      // Regexp routes expose captures by index, as Express does
      if (c.keys.length === 0) {
        for (let k = 1; k < m.length; k++) {
          if (m[k] !== undefined) params[String(k - 1)] = decodeParam(m[k])
        }
      }
      return { params, matched: m[0] ?? '' }
    }
    return null
  }
}

/** Matches everything, used when no path is given. */
export const MATCH_ALL: PathMatcher = {
  match: () => ({ params: {}, matched: '' }),
}

export function compilePath(path: PathSpec, opts: MatcherOptions): PathMatcher {
  const list = Array.isArray(path) ? path : [path]
  return new CompiledMatcher(list.map((p) => compileOne(p, opts)))
}
