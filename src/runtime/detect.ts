export type Runtime = 'node' | 'bun' | 'deno' | 'workerd' | 'unknown'

interface GlobalProbe {
  Bun?: unknown
  Deno?: unknown
  process?: { versions?: { node?: string } }
}

let cached: Runtime | undefined

/** Runtime fallback for environments where conditional exports cannot resolve statically. */
export function detectRuntime(): Runtime {
  if (cached !== undefined) return cached
  cached = probe()
  return cached
}

function probe(): Runtime {
  const g = globalThis as unknown as GlobalProbe
  if (typeof g.Bun !== 'undefined') return 'bun'
  if (typeof g.Deno !== 'undefined') return 'deno'
  if (typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers') {
    return 'workerd'
  }
  if (typeof g.process !== 'undefined' && g.process?.versions?.node) return 'node'
  return 'unknown'
}

export function hasNodeApis(): boolean {
  const r = detectRuntime()
  return r === 'node' || r === 'bun'
}

export function resetRuntimeCache(): void {
  cached = undefined
}
