/**
 * `app.listen()` for Node, Bun and Deno.
 *
 * The edge build aliases this module to `serve.edge.ts`. Bundlers follow dynamic imports, so leaving the `@hono/node-server` reference in would drag `node:http` into a Workers bundle — runtime detection alone is not enough.
 */

import { report } from '../diagnostics.js'
import { kActualStatus, kNodeStream, kRemoteAddress } from '../object-model.js'

export interface ServeTarget {
  fetch(request: Request, env?: unknown, ctx?: unknown): Promise<Response>
}

/** Minimal `http.Server`-shaped handle. */
export interface ServerHandle {
  address(): unknown
  close(callback?: () => void): void
  on(event: string, listener: (...args: unknown[]) => void): ServerHandle
  once(event: string, listener: (...args: unknown[]) => void): ServerHandle
}

interface GlobalRuntimes {
  Bun?: { serve: (options: unknown) => unknown }
  Deno?: { serve: (options: unknown, handler?: unknown) => unknown }
}

export function serve(
  app: ServeTarget,
  port: number | undefined,
  hostname: string | undefined,
  callback: ((err?: unknown) => void) | undefined,
): unknown {
  const g = globalThis as unknown as GlobalRuntimes

  if (g.Bun) {
    const server = g.Bun.serve({ port, hostname, fetch: app.fetch })
    callback?.()
    return server
  }

  if (g.Deno) {
    return g.Deno.serve({ port, hostname, onListen: callback }, app.fetch)
  }

  return serveNode(app, port, hostname, callback)
}

function serveNode(
  app: ServeTarget,
  port: number | undefined,
  hostname: string | undefined,
  callback: ((err?: unknown) => void) | undefined,
): ServerHandle {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  let server:
    | {
        address?: () => unknown
        close?: (cb?: () => void) => void
        on?: (event: string, listener: (...args: unknown[]) => void) => unknown
      }
    | undefined
  // The underlying node server is only created once the dynamic import below resolves
  // (kept dynamic so bundlers don't drag @hono/node-server into the edge build), so a
  // .close() called synchronously right after app.listen() -- as Express's own tests do
  // -- would otherwise land while `server` is still undefined and silently drop the
  // callback. Replayed against the real server once it exists instead.
  let pendingClose: (() => void) | undefined
  let closeRequested = false

  const handle: ServerHandle = {
    address: () => server?.address?.() ?? null,
    close: (cb) => {
      if (server) {
        server.close?.(cb)
        return
      }
      closeRequested = true
      pendingClose = cb
    },
    on: (event, listener) => {
      const bucket = listeners.get(event) ?? []
      bucket.push(listener)
      listeners.set(event, bucket)
      return handle
    },
    once: (event, listener) => handle.on(event, listener),
  }

  const emit = (event: string, ...args: unknown[]): void => {
    for (const fn of listeners.get(event) ?? []) fn(...args)
  }

  // Express calls the listen callback for both success and failure (`server.once('error',
  // done)` wraps the same function passed to `.listen()`), and guards it to fire at most
  // once since only one of 'listening' / 'error' ever actually happens.
  let callbackCalled = false
  const callOnce = (err?: unknown): void => {
    if (callbackCalled) return
    callbackCalled = true
    callback?.(err)
  }

  import('@hono/node-server')
    .then(({ serve: honoServe }) => {
      server = honoServe({ fetch: app.fetch, port, hostname }, (info: unknown) => {
        callOnce()
        emit('listening', info)
      }) as typeof server
      server?.on?.('error', (err: unknown) => {
        callOnce(err)
        emit('error', err)
      })
      if (closeRequested) server?.close?.(pendingClose)
    })
    .catch((err: unknown) => {
      report('EXPHONO_E001', { context: 'app.listen' })
      callOnce(err)
      emit('error', err)
    })

  return handle
}

/**
 * Runs a request that arrived through a Node HTTP server rather than a Fetch handler.
 *
 * `http.createServer(app)` and supertest hand Express real IncomingMessage / ServerResponse objects, so they have to be converted into a Fetch Request and back again.
 */
export async function handleNodeRequest(
  app: ServeTarget,
  req: NodeIncomingMessage,
  res: NodeServerResponse,
): Promise<void> {
  try {
    const request = await toFetchRequest(req)
    const response = await app.fetch(request)
    await writeFetchResponse(response, res)
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
    res.end(err instanceof Error ? err.message : String(err))
  }
}

export interface NodeIncomingMessage {
  method?: string
  url?: string
  rawHeaders: string[]
  headers: Record<string, string | string[] | undefined>
  socket?: { encrypted?: boolean; remoteAddress?: string }
}

export interface NodeServerResponse {
  headersSent: boolean
  writeHead(status: number, headers?: Record<string, string | string[]>): unknown
  write(chunk: unknown): unknown
  end(chunk?: unknown): unknown
}

const BODYLESS = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS', 'TRACE'])

/**
 * The Fetch standard forbids constructing a `Request` with these methods at all, since
 * they carry protocol-level meaning `fetch()` itself can't express. Express has no such
 * restriction, so a real Node request still needs to route on the real method — built as
 * `GET` and then shadowed with an own property, since `Request.prototype.method` is a
 * getter that an instance property takes priority over.
 */
const FORBIDDEN_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK'])

async function toFetchRequest(req: NodeIncomingMessage): Promise<Request> {
  const method = (req.method ?? 'GET').toUpperCase()
  const scheme = req.socket?.encrypted ? 'https' : 'http'
  const host = (req.headers.host as string | undefined) ?? 'localhost'
  // Concatenated rather than resolved via `new URL(path, base)`: a request-target starting
  // with `//` (e.g. `GET //todo@txt`) is a valid, if unusual, origin-form path, but the
  // two-argument URL constructor treats a leading `//` as a network-path reference and
  // reparses it as a different authority instead of keeping it as the pathname.
  const url = new URL(`${scheme}://${host}${req.url ?? '/'}`)

  const headers = new Headers()
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]
    const value = req.rawHeaders[i + 1]
    if (name !== undefined && value !== undefined) headers.append(name, value)
  }

  const forbidden = FORBIDDEN_METHODS.has(method)
  const init: RequestInit & { duplex?: string } = { method: forbidden ? 'GET' : method, headers }
  if (!BODYLESS.has(method)) {
    const { Readable } = await import('node:stream')
    init.body = Readable.toWeb(req as never) as ReadableStream
    init.duplex = 'half'
  }
  const request = new Request(url, init as RequestInit)
  if (forbidden) {
    Object.defineProperty(request, 'method', {
      value: method,
      configurable: true,
      enumerable: true,
    })
  }
  if (req.socket?.remoteAddress) {
    Object.defineProperty(request, kRemoteAddress, {
      value: req.socket.remoteAddress,
      configurable: true,
    })
  }
  // Kept even for a bodyless method's Request (which cannot carry `init.body` at all) so
  // connect-style middleware can still read the raw bytes via `req.on('data', ...)`.
  Object.defineProperty(request, kNodeStream, { value: req, configurable: true })
  return request
}

async function writeFetchResponse(response: Response, res: NodeServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  const setCookie = response.headers.getSetCookie?.() ?? []
  if (setCookie.length > 0) headers['set-cookie'] = setCookie

  const actualStatus = (response as unknown as Record<symbol, number | undefined>)[kActualStatus]
  res.writeHead(actualStatus ?? response.status, headers)

  if (!response.body) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    res.write(value)
  }
  res.end()
}
