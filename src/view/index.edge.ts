/**
 * Edge replacement for `view/index.ts`, aliased in at build time.
 *
 * There is no filesystem to search and no `require()`/dynamic `import()` of an arbitrary engine module, so `res.render` needs templates registered up front instead — see `configure({ views: { 'index.ejs': compiledFn } })` in the docs. Until that lands, view rendering reports EXPHONO_E002.
 */

import { fail } from '../diagnostics.js'
import type { RenderCallback } from './index.js'

export type { EngineFn, RenderCallback, ViewOptions } from './index.js'

export class View {
  static create(): never {
    return fail('EXPHONO_E002', 'View.create')
  }

  render(_options: object, callback: RenderCallback): void {
    callback(new Error('res.render is not implemented on this runtime yet'))
  }
}
