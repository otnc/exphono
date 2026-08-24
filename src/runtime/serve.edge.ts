/**
 * Edge replacement for `serve.ts`, aliased in at build time. Keeps `@hono/node-server`
 * and `node:http` out of the edge bundle entirely.
 */

import { fail } from '../diagnostics.js'

export type { ServerHandle, ServeTarget } from './serve.js'

export function serve(): never {
  return fail('EXPHONO_E001', 'app.listen')
}

export function handleNodeRequest(): never {
  return fail('EXPHONO_E001', 'http.createServer(app)')
}
