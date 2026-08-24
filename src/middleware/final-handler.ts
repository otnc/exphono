/**
 * Default error handler: 404 when nothing handled the request, otherwise the error's
 * status or 500. Stack traces are hidden in production.
 */

import type { ExpRequest } from '../request.js'
import type { ExpResponse } from '../response.js'

interface HttpError {
  status?: number
  statusCode?: number
  message?: string
  stack?: string
  headers?: Record<string, string>
}

export function finalHandler(
  err: unknown,
  req: ExpRequest,
  res: ExpResponse,
  env = 'development',
): void {
  if (res.writableEnded) return

  if (!err) {
    res.status(404)
    res.set('content-type', 'text/html; charset=utf-8')
    res.set('x-content-type-options', 'nosniff')
    res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Error</title></head>
<body><pre>Cannot ${escapeHtml(req.method)} ${escapeHtml(req.originalUrl)}</pre></body>
</html>
`)
    return
  }

  const e = err as HttpError
  const status = normalizeStatus(e.status ?? e.statusCode)

  if (e.headers) {
    for (const [k, v] of Object.entries(e.headers)) res.set(k, v)
  }

  const detail =
    env === 'production' ? statusMessage(status) : (e.stack ?? e.message ?? String(err))

  res.status(status)
  res.set('content-type', 'text/html; charset=utf-8')
  res.set('x-content-type-options', 'nosniff')
  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Error</title></head>
<body><pre>${escapeHtml(detail)}</pre></body>
</html>
`)
}

function normalizeStatus(status: number | undefined): number {
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 599) {
    return 500
  }
  return status
}

function statusMessage(status: number): string {
  return status === 404 ? 'Not Found' : 'Internal Server Error'
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
