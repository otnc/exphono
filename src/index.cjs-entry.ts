/**
 * CJS entry. Rolldown emits `exports.default = ...` by default, which breaks
 * `require('exphono')()`. Forcing `exports: 'default'` needs an entry with a single
 * default export, hence this file. Named exports ride along as function properties.
 */

import express from './index.js'

export default express
