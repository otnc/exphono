/**
 * `trust proxy` evaluation, matching the `proxy-addr` package.
 *
 * The setting decides which `X-Forwarded-*` hops to believe. It accepts a boolean, a hop
 * count, one or more addresses / CIDR ranges / subnet names, or a predicate.
 */

export type TrustSetting =
  | boolean
  | number
  | string
  | string[]
  | ((addr: string, hopIndex: number) => boolean)

export type TrustFn = (addr: string, hopIndex: number) => boolean

const SUBNETS: Record<string, string[]> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'],
}

/** Turns the `trust proxy` setting into a predicate over (address, hop index). */
export function compileTrust(value: TrustSetting | undefined): TrustFn {
  if (typeof value === 'function') return value
  if (value === true) return () => true
  if (value === undefined || value === false) return () => false

  if (typeof value === 'number') {
    // Trust the first N hops closest to this server
    return (_addr, i) => i < value
  }

  const list = (Array.isArray(value) ? value : String(value).split(/\s*,\s*/))
    .filter(Boolean)
    .flatMap((entry) => SUBNETS[entry] ?? [entry])

  const ranges = list.map(parseRange).filter((r): r is Range => r !== null)
  return (addr) => ranges.some((r) => inRange(addr, r))
}

interface Range {
  bytes: number[]
  prefix: number
}

function parseRange(entry: string): Range | null {
  const [addr, bits] = entry.split('/')
  const bytes = toBytes(addr ?? '')
  if (!bytes) return null
  const prefix = bits === undefined ? bytes.length * 8 : Number(bits)
  if (!Number.isFinite(prefix)) return null
  return { bytes, prefix }
}

/** IPv4 becomes 4 bytes, IPv6 becomes 16; an IPv4-mapped IPv6 collapses to IPv4. */
function toBytes(addr: string): number[] | null {
  const clean = addr.trim().replace(/^\[|\]$/g, '')

  if (clean.includes(':')) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(clean)
    if (mapped) return toBytes(mapped[1] as string)
    return ipv6ToBytes(clean)
  }

  const parts = clean.split('.')
  if (parts.length !== 4) return null
  const bytes = parts.map(Number)
  if (bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null
  return bytes
}

function ipv6ToBytes(addr: string): number[] | null {
  const [head, tail] = addr.split('::')
  const parse = (s: string): number[] =>
    s
      .split(':')
      .filter(Boolean)
      .flatMap((group) => {
        const n = Number.parseInt(group, 16)
        return [(n >> 8) & 0xff, n & 0xff]
      })

  const left = parse(head ?? '')
  const right = tail === undefined ? [] : parse(tail)
  if (tail === undefined && left.length !== 16) return null

  const fill = 16 - left.length - right.length
  if (fill < 0) return null
  return [...left, ...new Array(fill).fill(0), ...right]
}

function inRange(addr: string, range: Range): boolean {
  const bytes = toBytes(addr)
  if (!bytes || bytes.length !== range.bytes.length) return false

  let bits = range.prefix
  for (let i = 0; i < bytes.length && bits > 0; i++) {
    const take = Math.min(8, bits)
    const mask = take === 8 ? 0xff : (0xff << (8 - take)) & 0xff
    if (((bytes[i] as number) & mask) !== ((range.bytes[i] as number) & mask)) return false
    bits -= take
  }
  return true
}

/**
 * Walks the forwarded chain from this server outwards and returns the first address that
 * is not itself trusted — the client, as far as the proxies can be believed.
 */
export function resolveAddress(
  socketAddr: string | undefined,
  forwarded: string[],
  trust: TrustFn,
): string | undefined {
  const chain = [socketAddr, ...forwarded].filter((a): a is string => Boolean(a))
  for (let i = 0; i < chain.length - 1; i++) {
    if (!trust(chain[i] as string, i)) return chain[i]
  }
  return chain[chain.length - 1] ?? socketAddr
}

/** The forwarded chain, nearest hop first. */
export function forwardedChain(header: string | undefined): string[] {
  if (!header) return []
  return header
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .reverse()
}
