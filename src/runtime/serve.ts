/**
 * `app.listen()` for Node, Bun and Deno.
 *
 * The edge build aliases this module to `serve.edge.ts`. Bundlers follow dynamic imports,
 * so leaving the `@hono/node-server` reference in would drag `node:http` into a Workers
 * bundle — runtime detection alone is not enough.
 */

import { report } from '../diagnostics.js'

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
  callback: (() => void) | undefined,
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
  callback: (() => void) | undefined,
): ServerHandle {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  let server: { address?: () => unknown; close?: (cb?: () => void) => void } | undefined

  const handle: ServerHandle = {
    address: () => server?.address?.() ?? null,
    close: (cb) => {
      server?.close?.(cb)
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

  import('@hono/node-server')
    .then(({ serve: honoServe }) => {
      server = honoServe({ fetch: app.fetch, port, hostname }, (info: unknown) => {
        callback?.()
        emit('listening', info)
      }) as typeof server
    })
    .catch((err: unknown) => {
      report('EXPHONO_E001', { context: 'app.listen' })
      emit('error', err)
    })

  return handle
}

/**
 * Runs a request that arrived through a Node HTTP server rather than a Fetch handler.
 *
 * `http.createServer(app)` and supertest hand Express real IncomingMessage / ServerResponse
 * objects, so they have to be converted into a Fetch Request and back again.
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

async function toFetchRequest(req: NodeIncomingMessage): Promise<Request> {
  const method = (req.method ?? 'GET').toUpperCase()
  const scheme = req.socket?.encrypted ? 'https' : 'http'
  const host = (req.headers.host as string | undefined) ?? 'localhost'
  const url = new URL(req.url ?? '/', `${scheme}://${host}`)

  const headers = new Headers()
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]
    const value = req.rawHeaders[i + 1]
    if (name !== undefined && value !== undefined) headers.append(name, value)
  }

  const init: RequestInit & { duplex?: string } = { method, headers }
  if (!BODYLESS.has(method)) {
    const { Readable } = await import('node:stream')
    init.body = Readable.toWeb(req as never) as ReadableStream
    init.duplex = 'half'
  }
  return new Request(url, init as RequestInit)
}

async function writeFetchResponse(response: Response, res: NodeServerResponse): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  response.headers.forEach((value, key) => {
    headers[key] = value
  })
  const setCookie = response.headers.getSetCookie?.() ?? []
  if (setCookie.length > 0) headers['set-cookie'] = setCookie

  res.writeHead(response.status, headers)

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
