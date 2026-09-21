/**
 * A port of `path-to-regexp@0.1.x`, the path syntax behind Express 4's router.
 *
 * Kept as close to the original as possible: its quirks (`'*'` capturing across segments as a plain string, `.:format?`, `\(` escapes, unnamed groups numbered in order) are exactly what Express 4 apps rely on, so they are reproduced rather than approximated.
 */

interface PathKey {
  name: string | number
  optional: boolean
  offset: number
}

export interface PathRegexp {
  regexp: RegExp
  keys: PathKey[]
}

const MATCHING_GROUP = /\\.|\((?:\?<(.*?)>)?(?!\?)/g

const TOKEN = /\\.|(\/)?(\.)?:(\w+)(\(.*?\))?(\*)?(\?)?|[.*]|\/\(/g

export function pathToRegexpV4(
  pathInput: string,
  options: { strict: boolean; end: boolean; sensitive: boolean },
): PathRegexp {
  const keys: PathKey[] = []
  const flags = options.sensitive ? '' : 'i'
  let extraOffset = 0
  let i = 0
  let name = 0
  let pos = 0
  let backtrack = ''

  let path = pathInput.replace(
    TOKEN,
    (
      match: string,
      slash: string | undefined,
      format: string | undefined,
      key: string,
      capture: string | undefined,
      star: string | undefined,
      optional: string | undefined,
      offset: number,
    ) => {
      if (match[0] === '\\') {
        backtrack += match
        pos += 2
        return match
      }

      if (match === '.') {
        backtrack += '\\.'
        extraOffset += 1
        pos += 1
        return '\\.'
      }

      if (slash || format) {
        backtrack = ''
      } else {
        backtrack += pathInput.slice(pos, offset)
      }

      pos = offset + match.length

      if (match === '*') {
        backtrack = ''
        extraOffset += 3
        return '(.*)'
      }

      if (match === '/(') {
        backtrack += '/'
        extraOffset += 2
        return '/(?:'
      }

      const lead = slash || ''
      const dot = format ? '\\.' : ''
      const opt = optional || ''
      const group = capture
        ? capture.replace(/\\.|\*/, (c) => (c === '*' ? '(.*)' : c))
        : backtrack
          ? `((?:(?!/|${backtrack}).)+?)`
          : `([^/${dot}]+?)`

      keys.push({ name: key, optional: !!opt, offset: offset + extraOffset })

      const result = `(?:${dot}${lead}${group}${star ? `((?:[/${dot}].+?)?)` : ''})${opt}`

      backtrack = ''
      extraOffset += result.length - match.length

      return result
    },
  )

  // Unnamed matching groups still occupy a capture slot, so they get numbered keys in order.
  for (const m of path.matchAll(MATCHING_GROUP)) {
    if (m[0][0] === '\\') continue

    const existing = keys[i]
    if (i === keys.length || (existing && existing.offset > m.index)) {
      keys.splice(i, 0, { name: name++, optional: false, offset: m.index })
    }

    i++
  }

  path += options.strict ? '' : path[path.length - 1] === '/' ? '?' : '/?'

  if (options.end) {
    path += '$'
  } else if (path[path.length - 1] !== '/') {
    path += '(?=/|$)'
  }

  return { regexp: new RegExp(`^${path}`, flags), keys }
}
