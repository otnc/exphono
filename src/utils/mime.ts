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

/** Accepts a bare extension ('js'), a dotted one ('.js') or a whole filename ('foo.js'). */
export function lookupMimeType(ext: string): string {
  const base = ext.split(/[\\/]/).pop() ?? ext
  const dot = base.lastIndexOf('.')
  const bare = dot === -1 ? base : base.slice(dot + 1)
  return MIME[bare.toLowerCase()] ?? 'application/octet-stream'
}

/** Adds `charset=utf-8` to the types that need it. */
export function withCharset(type: string): string {
  if (type.includes('charset')) return type
  if (/^text\//.test(type) || type === 'application/json' || type === 'image/svg+xml') {
    return `${type}; charset=utf-8`
  }
  return type
}
