/**
 * `express.static`.
 *
 * Falls through to the next middleware by default, so a missing file is a 404 from the router rather than from here.
 */

import { report } from '../diagnostics.js'
import type { ExpRequest } from '../request.js'
import type { ExpResponse } from '../response.js'
import type { NextFunction, RequestHandler } from '../router/index.js'
import { hasFileSystem } from '../runtime/files.js'
import { encodeUrl } from '../utils/url.js'
import { SendError, type SendOptions, sendFile } from './send.js'

export interface StaticOptions extends SendOptions {
  /** Pass unmatched requests to the next middleware instead of erroring. */
  fallthrough?: boolean
  /** Redirect a directory request without a trailing slash. */
  redirect?: boolean
}

function originalPathname(originalUrl: string): string {
  const q = originalUrl.indexOf('?')
  return q === -1 ? originalUrl : originalUrl.slice(0, q)
}

function collapseLeadingSlashes(path: string): string {
  let i = 0
  while (i < path.length && path.charCodeAt(i) === 0x2f) i++
  return i > 1 ? `/${path.slice(i)}` : path
}

/** The minimal redirect page `serve-static` sends alongside the `Location` header. */
function directoryRedirectDocument(location: string): string {
  const escaped = location.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
  return (
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    `<title>Redirecting</title>\n</head>\n<body>\n<pre>Redirecting to ${escaped}</pre>\n</body>\n</html>\n`
  )
}

function redirectToTrailingSlash(req: ExpRequest, res: ExpResponse): void {
  const pathname = originalPathname(req.originalUrl)
  const search = req.originalUrl.slice(pathname.length)
  const location = encodeUrl(collapseLeadingSlashes(`${pathname}/`) + search)
  const doc = directoryRedirectDocument(location)

  res.status(301)
  res.set('content-type', 'text/html; charset=UTF-8')
  res.set('content-security-policy', "default-src 'none'")
  res.set('x-content-type-options', 'nosniff')
  res.set('location', location)
  res.send(doc)
}

export function serveStatic(root: string, options?: StaticOptions): RequestHandler {
  if (!root) throw new TypeError('root path required')
  if (typeof root !== 'string') throw new TypeError('root path must be a string')
  const opts = options ?? {}
  if (opts.setHeaders !== undefined && typeof opts.setHeaders !== 'function') {
    throw new TypeError('option setHeaders must be function')
  }

  const fallthrough = opts.fallthrough !== false
  const redirect = opts.redirect !== false
  const sendOptions: SendOptions = { ...opts, root }

  return (req: ExpRequest, res: ExpResponse, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (fallthrough) {
        next()
        return
      }
      res.set('allow', 'GET, HEAD')
      const err = new SendError(405, 'Method Not Allowed')
      next(err)
      return
    }

    if (!hasFileSystem) {
      report('EXPHONO_E003', { context: 'express.static' })
      next()
      return
    }

    // Mirrors `send`'s own mount-point handling: at the mount root, without a trailing slash on the real URL, the lookup path is emptied so the directory check below still fires and redirects relative to the original (mount-prefixed) URL.
    const atMountRoot = req.path === '/' && !originalPathname(req.originalUrl).endsWith('/')
    // req.path has already been through the router's own URL parsing, which -- as a side
    // effect of just being a normal URL parser -- silently collapses `..` segments
    // (`/a/../b` -> `/b`) before send's own traversal check ever runs. req.originalUrl is
    // the client's literal, unresolved string (on Node; elsewhere the platform hands
    // ExpHono an already-parsed Request, so this degrades to the same normalized value).
    const rawPath = originalPathname(req.originalUrl).slice(req.baseUrl.length) || '/'
    const path = atMountRoot ? '' : rawPath

    sendFile(req, res, path, sendOptions)
      .then(() => undefined)
      .catch((err: unknown) => {
        const sendErr = err as SendError
        // A directory hit only turns into a redirect when the request itself had no trailing slash — `send` re-checks this even after routing through the directory handler, since a mount-root lookup can still end up with one.
        if (sendErr?.isDirectory && redirect && !path.endsWith('/')) {
          redirectToTrailingSlash(req, res)
          return
        }
        const status = sendErr?.isDirectory ? 404 : sendErr?.status
        if (fallthrough && !sendErr?.fileFound && status !== undefined && status < 500) {
          next()
          return
        }
        next(err)
      })
  }
}
