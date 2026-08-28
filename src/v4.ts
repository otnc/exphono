/**
 * `exphono/v4` — the same API pinned to Express 4 semantics.
 *
 * Useful when migrating an Express 4 app: `req.query` keeps the extended parser,
 * `req.host` strips the port, and the APIs Express 5 removed still work.
 */

import { buildFactory } from './factory.js'

export * from './index.js'

const factory = buildFactory({ getCompat: () => '4' })

export default factory
