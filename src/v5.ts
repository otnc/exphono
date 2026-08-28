/**
 * `exphono/v5` — the same API pinned to Express 5 semantics.
 *
 * Pins the default explicitly, so the behaviour does not shift if the default changes.
 */

import { buildFactory } from './factory.js'

export * from './index.js'

const factory = buildFactory({ getCompat: () => '5' })

export default factory
