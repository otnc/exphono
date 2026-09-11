/** Minimal extension-to-type table, covering the types a web app usually serves. */

const MIME: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  map: 'application/json',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  css: 'text/css',
  xml: 'application/xml',
  csv: 'text/csv',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  wasm: 'application/wasm',
  bin: 'application/octet-stream',
  form: 'application/x-www-form-urlencoded',
  urlencoded: 'application/x-www-form-urlencoded',
  multipart: 'multipart/form-data',
}

/**
 * Accepts a bare extension ('js'), a dotted one ('.js') or a whole filename ('foo.js').
 * Under compat=4, JS files map to the older `application/javascript` mime-db entry -- the IANA/WHATWG registration change to `text/javascript` postdates Express 4.
 */
export function lookupMimeType(ext: string, compat: '4' | '5' = '5'): string {
  const base = ext.split(/[\\/]/).pop() ?? ext
  const dot = base.lastIndexOf('.')
  const bare = (dot === -1 ? base : base.slice(dot + 1)).toLowerCase()
  if (compat === '4' && (bare === 'js' || bare === 'mjs' || bare === 'cjs')) {
    return 'application/javascript'
  }
  return MIME[bare] ?? 'application/octet-stream'
}

/**
 * Adds a charset to the types that need one -- lowercase `utf-8` under Express 5's mime-db, uppercase `UTF-8` under Express 4's older one. Only affects types resolved through this lookup (`res.type()`, and `express.static`/`res.sendFile`/`res.download` by extension); an explicit `charset=` already on the type, or one hardcoded elsewhere (`res.json()`'s), is untouched.
 */
export function withCharset(type: string, compat: '4' | '5' = '5'): string {
  if (type.includes('charset')) return type
  if (
    /^text\//.test(type) ||
    type === 'application/json' ||
    type === 'image/svg+xml' ||
    // Express 4's older mime-db entry for .js -- text/javascript (the current one) already matches the text/ prefix above.
    type === 'application/javascript'
  ) {
    return `${type}; charset=${compat === '4' ? 'UTF-8' : 'utf-8'}`
  }
  return type
}
