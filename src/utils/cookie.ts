/** Minimal cookie serialisation and parsing. */

export interface CookieOptions {
  maxAge?: number
  expires?: Date
  path?: string
  domain?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: boolean | 'lax' | 'strict' | 'none'
  partitioned?: boolean
  priority?: 'low' | 'medium' | 'high'
  signed?: boolean
  encode?: (value: string) => string
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const encode = options.encode ?? encodeURIComponent
  const parts = [`${name}=${encode(value)}`]

  if (options.maxAge !== undefined) {
    if (!Number.isFinite(options.maxAge)) throw new TypeError('option maxAge is invalid')
    parts.push(`Max-Age=${Math.floor(options.maxAge)}`)
  }
  if (options.domain) parts.push(`Domain=${options.domain}`)
  parts.push(`Path=${options.path ?? '/'}`)
  if (options.expires) {
    if (Number.isNaN(options.expires.getTime())) throw new TypeError('option expires is invalid')
    parts.push(`Expires=${options.expires.toUTCString()}`)
  }
  if (options.httpOnly) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  if (options.partitioned) parts.push('Partitioned')
  if (options.priority) {
    const priority = String(options.priority).toLowerCase()
    if (!['low', 'medium', 'high'].includes(priority)) {
      throw new TypeError('option priority is invalid')
    }
    parts.push(`Priority=${capitalize(priority)}`)
  }
  if (options.sameSite) {
    const v = options.sameSite === true ? 'Strict' : capitalize(String(options.sameSite))
    parts.push(`SameSite=${v}`)
  }
  return parts.join('; ')
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null)
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const key = part.slice(0, eq).trim()
    if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    let value = part.slice(eq + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    try {
      out[key] = decodeURIComponent(value)
    } catch {
      out[key] = value
    }
  }
  return out
}
