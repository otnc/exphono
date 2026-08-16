/**
 * Diagnostics and strict mode.
 *
 * Anything exphono degrades is surfaced with a stable code rather than silently ignored.
 * By default each code warns once and execution continues; strict mode throws instead.
 */

/** Stable diagnostic codes, also used as documentation anchors. */
export const DIAGNOSTICS = {
  EXPHONO_E001: {
    title: 'app.listen() is not available on this runtime',
    detail: 'This runtime does not expose a TCP listener; it invokes your default export instead.',
    fix: 'export default app.worker;',
  },
  EXPHONO_E002: {
    title: 'View could not be resolved',
    detail:
      'Template rendering needs a filesystem, or templates registered up front on this runtime.',
    fix: "app.set('views', ...) on Node, or configure({ views: { 'index.ejs': fn } }) on the edge.",
  },
  EXPHONO_E003: {
    title: 'Filesystem is not reachable',
    detail: 'express.static / res.sendFile / res.download need a filesystem or an asset binding.',
    fix: 'Bind static assets (env.ASSETS) or serve them from your CDN.',
  },
  EXPHONO_E004: {
    title: 'Express 4 path syntax is invalid under compat=5',
    detail: "Express 5 requires named wildcards ('*splat') and brace optionals ('{/:id}').",
    fix: "Pin compat with `import express from 'exphono/v4'`, or migrate the path syntax.",
  },
  EXPHONO_E005: {
    title: 'Cannot tell whether this middleware is Express- or Hono-shaped',
    detail: 'The function arity is ambiguous (rest args or zero declared parameters).',
    fix: 'Wrap it explicitly: app.use(honoMiddleware(fn)).',
  },
  EXPHONO_E006: {
    title: 'ETag hash differs from Express',
    detail: 'This runtime has no synchronous MD5, so a different (still stable) hash is used.',
    fix: "Provide your own with app.set('etag', fn) if byte-identical ETags matter.",
  },
  EXPHONO_E007: {
    title: 'Replacing c.res in a Hono middleware has no effect',
    detail:
      'Express middleware returns from next() synchronously, so post-next response swapping cannot be applied.',
    fix: 'Rewrite the route as a Hono handler, or mutate headers before calling next().',
  },
  EXPHONO_E008: {
    title: 'This API only exists in Express 4',
    detail: 'It was removed in Express 5 and is only available under compat=4.',
    fix: "Use `import express from 'exphono/v4'`, or migrate off the deprecated API.",
  },
  EXPHONO_E009: {
    title: 'Depending on an Express internal',
    detail:
      "exphono keeps the name, but its internal structure differs, so behaviour isn't guaranteed.",
    fix: 'Prefer the public API.',
  },
  EXPHONO_E010: {
    title: 'Deep import of express internals cannot be resolved',
    detail: "exphono does not expose 'express/lib/*'.",
    fix: 'Use the public API surface.',
  },
  EXPHONO_E011: {
    title: 'A namespace import cannot be called',
    detail: '`import * as express` produces a module namespace object, which is not callable.',
    fix: "Use `import express from 'exphono'`.",
  },
  EXPHONO_E012: {
    title: 'This API is not implemented yet',
    detail: 'The surface exists so your code loads, but calling it does nothing useful yet.',
    fix: 'Track progress in the compatibility table.',
  },
} as const

export type DiagnosticCode = keyof typeof DIAGNOSTICS

const DOCS_BASE = 'https://github.com/otnc/exphono/blob/main/docs/errors.md'

/** Base class for errors exphono throws. */
export class ExphonoError extends Error {
  readonly code: DiagnosticCode

  constructor(code: DiagnosticCode, context?: string) {
    super(formatMessage(code, context))
    this.name = 'ExphonoError'
    this.code = code
  }
}

/** Thrown when strict mode reaches an unsupported or degraded API. */
export class ExphonoUnsupportedError extends ExphonoError {
  constructor(code: DiagnosticCode, context?: string) {
    super(code, context)
    this.name = 'ExphonoUnsupportedError'
  }
}

function formatMessage(code: DiagnosticCode, context?: string): string {
  const d = DIAGNOSTICS[code]
  const where = context ? ` (${context})` : ''
  return [
    `[${code}] ${d.title}${where}`,
    '',
    d.detail,
    '',
    `  - ${d.fix}`,
    '',
    `See: ${DOCS_BASE}#${code.toLowerCase()}`,
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Strict mode and warning de-duplication
// ─────────────────────────────────────────────────────────────────────────────

let globalStrict = readStrictFromEnv()
const warned = new Set<string>()

function readStrictFromEnv(): boolean {
  try {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    const v = proc?.env?.EXPHONO_STRICT
    return v === '1' || v === 'true'
  } catch {
    return false
  }
}

/** Sets the process-wide default; per-app settings override it. */
export function setGlobalStrict(value: boolean): void {
  globalStrict = value
}

export function isGlobalStrict(): boolean {
  return globalStrict
}

/** Test helper. */
export function resetDiagnostics(): void {
  warned.clear()
}

export interface ReportOptions {
  /** Per-app strict setting; falls back to the global one. */
  strict?: boolean
  /** Where it happened, included in the message. */
  context?: string
}

/**
 * Reports a degradation: throws under strict mode, otherwise warns once per code.
 * On the edge the dedupe state resets per isolate, so it is effectively once per start.
 */
export function report(code: DiagnosticCode, options: ReportOptions = {}): void {
  const strict = options.strict ?? globalStrict
  if (strict) throw new ExphonoUnsupportedError(code, options.context)

  const key = options.context ? `${code}:${options.context}` : code
  if (warned.has(key)) return
  warned.add(key)
  console.warn(formatMessage(code, options.context))
}

/** Always throws. */
export function fail(code: DiagnosticCode, context?: string): never {
  throw new ExphonoUnsupportedError(code, context)
}
