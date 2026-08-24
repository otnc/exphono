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
