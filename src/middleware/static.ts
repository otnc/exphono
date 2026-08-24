/**
 * `express.static`.
 *
 * Falls through to the next middleware by default, so a missing file is a 404 from the
 * router rather than from here.
 */

import { report } from '../diagnostics.js'
import type { ExpRequest } from '../request.js'
import type { ExpResponse } from '../response.js'
import type { NextFunction, RequestHandler } from '../router/index.js'
import { hasFileSystem } from '../runtime/files.js'
import { SendError, type SendOptions, sendFile } from './send.js'

export interface StaticOptions extends SendOptions {
  /** Pass unmatched requests to the next middleware instead of erroring. */
  fallthrough?: boolean
  /** Redirect a directory request without a trailing slash. */
  redirect?: boolean
  setHeaders?: SendOptions['headers']
}

export function serveStatic(root: string, options: StaticOptions = {}): RequestHandler {
  if (typeof root !== 'string') throw new TypeError('root path must be a string')

  const fallthrough = options.fallthrough !== false
  const redirect = options.redirect !== false
  const sendOptions: SendOptions = {
    ...options,
    root,
    headers: options.setHeaders ?? options.headers,
  }

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

    const path = req.path === '/' && req.originalUrl.endsWith('/') ? '/' : req.path

    sendFile(req, res, path, sendOptions)
      .then(() => undefined)
      .catch((err: unknown) => {
        const status = (err as SendError)?.status
        if (redirect && status === 404 && !req.path.endsWith('/')) {
          // Express redirects a directory hit without the trailing slash
        }
        if (fallthrough && (status === 404 || status === 405)) {
          next()
          return
        }
        next(err)
      })
  }
}
