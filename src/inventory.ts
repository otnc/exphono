/**
 * Single source of truth for every public API exphono exposes.
 *
 * Drives the surface tests, the compatibility table and the migration CLI.
 * Compiled from the express 4.22.2 / 5.2.1 / router 2.2.0 sources.
 */

/** How faithfully an API is reproduced. */
export type CoverageClass =
  /** Matches Express on every runtime. */
  | 'F'
  /** Complete on Node and Bun; substituted or unavailable on the edge. */
  | 'N'
  /** Works everywhere, with known behavioural differences. */
  | 'D'
  /** Express 4 only; removed in 5. */
  | 'C4'
  /** Cannot be provided. */
  | 'X'

/** Express major version being reproduced. */
export type CompatMode = '4' | '5'

/** Object the API lives on. */
export type ApiTarget =
  | 'module'
  | 'app'
  | 'request'
  | 'response'
  | 'router'
  | 'route'
  | 'layer'
  | 'view'

/** `setting` and `event` are not real properties, so surface tests skip them. */
export type ApiKind = 'method' | 'getter' | 'property' | 'setting' | 'event'

export interface ApiEntry {
  /** Property name; some, like `m-search`, are not valid identifiers. */
  readonly name: string
  readonly target: ApiTarget
  readonly kind: ApiKind
  /** Express majors that have this API. */
  readonly compat: readonly CompatMode[]
  readonly klass: CoverageClass
  /** Diagnostic emitted when degraded or unsupported. */
  readonly code?: string
  /** Shown in the compatibility table. */
  readonly note?: string
}

/**
 * The 35 HTTP methods Express registers. Hard-coded because `http.METHODS` does not
 * exist on the edge; express 4 and 5 were verified to agree on this list.
 *
 * `m-search` is only reachable as `app['m-search'](...)`, `delete` is a reserved word
 * that still works as a property, and `query` is a method here, unrelated to the
 * `query parser` setting.
 */
export const HTTP_METHODS = [
  'acl',
  'bind',
  'checkout',
  'connect',
  'copy',
  'delete',
  'get',
  'head',
  'link',
  'lock',
  'm-search',
  'merge',
  'mkactivity',
  'mkcalendar',
  'mkcol',
  'move',
  'notify',
  'options',
  'patch',
  'post',
  'propfind',
  'proppatch',
  'purge',
  'put',
  'query',
  'rebind',
  'report',
  'search',
  'source',
  'subscribe',
  'trace',
  'unbind',
  'unlink',
  'unlock',
  'unsubscribe',
] as const

export type HttpMethod = (typeof HTTP_METHODS)[number]

const BOTH: readonly CompatMode[] = ['4', '5']
const V4: readonly CompatMode[] = ['4']
const V5: readonly CompatMode[] = ['5']

function entry(
  target: ApiTarget,
  kind: ApiKind,
  name: string,
  compat: readonly CompatMode[],
  klass: CoverageClass,
  code?: string,
  note?: string,
): ApiEntry {
  return { name, target, kind, compat, klass, code, note }
}

const m = (
  t: ApiTarget,
  n: string,
  c = BOTH,
  k: CoverageClass = 'F',
  code?: string,
  note?: string,
) => entry(t, 'method', n, c, k, code, note)
const g = (
  t: ApiTarget,
  n: string,
  c = BOTH,
  k: CoverageClass = 'F',
  code?: string,
  note?: string,
) => entry(t, 'getter', n, c, k, code, note)
const p = (
  t: ApiTarget,
  n: string,
  c = BOTH,
  k: CoverageClass = 'F',
  code?: string,
  note?: string,
) => entry(t, 'property', n, c, k, code, note)

// ─────────────────────────────────────────────────────────────────────────────
// Module exports
// ─────────────────────────────────────────────────────────────────────────────

const MODULE: readonly ApiEntry[] = [
  p('module', 'application', BOTH, 'F', undefined, 'app prototype'),
  p('module', 'request', BOTH, 'F', undefined, 'req prototype'),
  p('module', 'response', BOTH, 'F', undefined, 'res prototype'),
  m('module', 'Route', BOTH, 'F', undefined, 'real, but missing from @types/express'),
  m('module', 'Router'),
  m('module', 'json'),
  m('module', 'raw'),
  m('module', 'text'),
  m('module', 'urlencoded'),
  m('module', 'static', BOTH, 'N', 'EXPHONO_E003', 'served via asset bindings on the edge'),
  m('module', 'query', V4, 'C4', 'EXPHONO_E008', 'removed in v5'),
]

// ─────────────────────────────────────────────────────────────────────────────
// C.2 Application
// ─────────────────────────────────────────────────────────────────────────────

const APPLICATION: readonly ApiEntry[] = [
  m('app', 'all'),
  m('app', 'del', V4, 'C4', 'EXPHONO_E008', 'deprecated alias for delete'),
  m('app', 'disable'),
  m('app', 'disabled'),
  m('app', 'enable'),
  m('app', 'enabled'),
  m('app', 'engine', BOTH, 'N', 'EXPHONO_E002', 'template engine registration'),
  m('app', 'get', BOTH, 'F', undefined, 'one argument reads a setting'),
  m('app', 'handle'),
  m('app', 'init'),
  m('app', 'lazyrouter', V4, 'D', 'EXPHONO_E009', 'internal; provided as a no-op'),
  m('app', 'listen', BOTH, 'N', 'EXPHONO_E001', 'unavailable on Workers'),
  m('app', 'param'),
  m('app', 'path'),
  m('app', 'render', BOTH, 'N', 'EXPHONO_E002'),
  m('app', 'route'),
  m('app', 'set'),
  m('app', 'use'),
  p('app', 'cache'),
  p('app', 'engines'),
  p('app', 'locals'),
  p('app', 'mountpath'),
  p('app', 'parent'),
  p('app', 'request'),
  p('app', 'response'),
  p('app', 'settings'),
  g('app', 'router', V5, 'D', 'EXPHONO_E009', 'getter in v5'),
  // EventEmitter
  ...(
    [
      'addListener',
      'emit',
      'eventNames',
      'getMaxListeners',
      'listenerCount',
      'listeners',
      'off',
      'on',
      'once',
      'prependListener',
      'prependOnceListener',
      'rawListeners',
      'removeAllListeners',
      'removeListener',
      'setMaxListeners',
    ] as const
  ).map((n) => m('app', n, BOTH, 'F', undefined, 'EventEmitter')),
  entry('app', 'event', 'mount', BOTH, 'F', undefined, 'emitted when mounted as a sub-app'),
]

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────

const SETTINGS: readonly ApiEntry[] = (
  [
    ['env', 'F'],
    ['etag', 'F'],
    ['etag fn', 'F'],
    ['query parser', 'F'],
    ['query parser fn', 'F'],
    ['trust proxy', 'F'],
    ['trust proxy fn', 'F'],
    ['subdomain offset', 'F'],
    ['view', 'N'],
    ['views', 'N'],
    ['view cache', 'N'],
    ['view engine', 'N'],
    ['jsonp callback name', 'F'],
    ['case sensitive routing', 'F'],
    ['strict routing', 'F'],
    ['json replacer', 'F'],
    ['json spaces', 'F'],
    ['json escape', 'F'],
    ['x-powered-by', 'F'],
  ] as const
).map(([name, klass]) => entry('app', 'setting', name, BOTH, klass as CoverageClass))

// ─────────────────────────────────────────────────────────────────────────────
// C.4 Request
// ─────────────────────────────────────────────────────────────────────────────

const REQUEST: readonly ApiEntry[] = [
  m('request', 'accepts'),
  m('request', 'acceptsCharsets'),
  m('request', 'acceptsEncodings'),
  m('request', 'acceptsLanguages'),
  m('request', 'acceptsCharset', V4, 'C4', 'EXPHONO_E008', 'deprecated alias'),
  m('request', 'acceptsEncoding', V4, 'C4', 'EXPHONO_E008', 'deprecated alias'),
  m('request', 'acceptsLanguage', V4, 'C4', 'EXPHONO_E008', 'deprecated alias'),
  m('request', 'get'),
  m('request', 'header'),
  m('request', 'is'),
  m('request', 'param', V4, 'C4', 'EXPHONO_E008', 'removed in v5'),
  m('request', 'range'),
  g('request', 'fresh'),
  g('request', 'host', BOTH, 'F', undefined, 'v4 strips the port, v5 keeps it'),
  g('request', 'hostname'),
  g('request', 'ip'),
  g('request', 'ips'),
  g('request', 'path'),
  g('request', 'protocol'),
  g('request', 'query', V5, 'F', undefined, 'getter in v5, null prototype'),
  g('request', 'secure'),
  g('request', 'stale'),
  g('request', 'subdomains'),
  g('request', 'xhr'),
  p('request', 'query', V4, 'F', undefined, 'set by the query middleware in v4'),
  p('request', 'app'),
  p('request', 'baseUrl'),
  p('request', 'body'),
  p('request', 'cookies'),
  p('request', 'signedCookies'),
  p('request', 'method'),
  p('request', 'originalUrl'),
  p('request', 'params'),
  p('request', 'res'),
  p('request', 'next'),
  p('request', 'route'),
  p('request', 'url'),
  p('request', 'headers'),
  p('request', 'rawHeaders'),
  // Node lookalikes
  p('request', 'socket', BOTH, 'D', 'EXPHONO_E009', 'stand-in object'),
  p('request', 'connection', BOTH, 'D', 'EXPHONO_E009', 'stand-in object'),
  p('request', 'httpVersion', BOTH, 'D'),
  p('request', 'httpVersionMajor', BOTH, 'D'),
  p('request', 'httpVersionMinor', BOTH, 'D'),
  p('request', 'complete', BOTH, 'D'),
]

// ─────────────────────────────────────────────────────────────────────────────
// C.5 Response
// ─────────────────────────────────────────────────────────────────────────────

const RESPONSE: readonly ApiEntry[] = [
  m('response', 'append'),
  m('response', 'attachment'),
  m('response', 'clearCookie'),
  m('response', 'contentType'),
  m('response', 'cookie'),
  m('response', 'download', BOTH, 'N', 'EXPHONO_E003'),
  m('response', 'format'),
  m('response', 'get'),
  m('response', 'header'),
  m('response', 'json'),
  m('response', 'jsonp'),
  m('response', 'links'),
  m('response', 'location'),
  m('response', 'redirect'),
  m('response', 'render', BOTH, 'N', 'EXPHONO_E002'),
  m('response', 'send'),
  m('response', 'sendFile', BOTH, 'N', 'EXPHONO_E003'),
  m('response', 'sendfile', V4, 'C4', 'EXPHONO_E008', 'lowercase, deprecated'),
  m('response', 'sendStatus'),
  m('response', 'set'),
  m('response', 'status'),
  m('response', 'type'),
  m('response', 'vary'),
  p('response', 'app'),
  p('response', 'locals'),
  p('response', 'req'),
  p('response', 'statusCode'),
  p('response', 'statusMessage'),
  p('response', 'headersSent'),
  // Node ServerResponse surface
  m('response', 'write'),
  m('response', 'end'),
  m(
    'response',
    'writeHead',
    BOTH,
    'F',
    undefined,
    'called internally when headers commit, for on-headers',
  ),
  m('response', 'setHeader'),
  m('response', 'getHeader'),
  m('response', 'getHeaders'),
  m('response', 'getHeaderNames'),
  m('response', 'hasHeader'),
  m('response', 'removeHeader'),
  m('response', 'flushHeaders'),
  p('response', 'socket', BOTH, 'D', 'EXPHONO_E009', 'stand-in object'),
  p('response', 'writableEnded', BOTH, 'D'),
  p('response', 'finished', BOTH, 'D'),
  p('response', 'sendDate', BOTH, 'D', undefined, 'accepted and ignored'),
]

// ─────────────────────────────────────────────────────────────────────────────
// C.6 Router / Route / Layer / View
// ─────────────────────────────────────────────────────────────────────────────

const ROUTER: readonly ApiEntry[] = [
  m('router', 'handle'),
  m('router', 'param'),
  m('router', 'route'),
  m('router', 'use'),
  m('router', 'all'),
  p('router', 'stack', BOTH, 'D', 'EXPHONO_E009', 'readable; mutating it is unsupported'),
]

const ROUTE: readonly ApiEntry[] = [
  m('route', 'all'),
  m('route', 'dispatch'),
  m('route', '_handles_method', BOTH, 'D', 'EXPHONO_E009'),
  m('route', '_options', BOTH, 'D', 'EXPHONO_E009'),
  p('route', 'path'),
  p('route', 'methods'),
  p('route', 'stack', BOTH, 'D', 'EXPHONO_E009'),
]

const LAYER: readonly ApiEntry[] = [
  m('layer', 'handle_request', BOTH, 'D', 'EXPHONO_E009', 'internal name kept'),
  m('layer', 'handle_error', BOTH, 'D', 'EXPHONO_E009', 'internal name kept'),
  m('layer', 'match', BOTH, 'D', 'EXPHONO_E009'),
]

const VIEW: readonly ApiEntry[] = [
  m('view', 'lookup', BOTH, 'N', 'EXPHONO_E002'),
  m('view', 'render', BOTH, 'N', 'EXPHONO_E002'),
  m('view', 'resolve', BOTH, 'N', 'EXPHONO_E002'),
]

// ─────────────────────────────────────────────────────────────────────────────

/** Verb methods, expanded across app, router and route. */
const VERB_ENTRIES: readonly ApiEntry[] = (['app', 'router', 'route'] as const).flatMap((t) =>
  HTTP_METHODS.map((verb) => m(t, verb, BOTH, 'F', undefined, 'HTTP verb')),
)

export const INVENTORY: readonly ApiEntry[] = [
  ...MODULE,
  ...APPLICATION,
  ...SETTINGS,
  ...REQUEST,
  ...RESPONSE,
  ...ROUTER,
  ...ROUTE,
  ...LAYER,
  ...VIEW,
  ...VERB_ENTRIES,
]

/** APIs on a target, optionally narrowed to one Express major. */
export function apisFor(target: ApiTarget, compat?: CompatMode): readonly ApiEntry[] {
  return INVENTORY.filter(
    (e) => e.target === target && (compat === undefined || e.compat.includes(compat)),
  )
}

/** APIs that exist as real properties, so surface tests can check them. */
export function surfaceApisFor(target: ApiTarget, compat?: CompatMode): readonly ApiEntry[] {
  return apisFor(target, compat).filter((e) => e.kind !== 'setting' && e.kind !== 'event')
}

export const SETTING_KEYS: readonly string[] = SETTINGS.map((e) => e.name)
