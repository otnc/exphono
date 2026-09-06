/**
 * View lookup and rendering for Node and Bun.
 *
 * Ported closely from Express's own `lib/view.js`: resolves `<path>.<ext>` then
 * `<path>/index.<ext>` across each root in turn, and loads the engine's `.__express`
 * export when one is not registered via `app.engine()`.
 *
 * Aliased to `view.edge.ts` on the edge, where there is no filesystem to search and
 * `require()` cannot load an engine module.
 */

import { isAbsolutePath, joinPath, resolvePath, statFile } from '../runtime/files.js'

export type RenderCallback = (err: unknown, html?: string) => void
export type EngineFn = (path: string, options: object, callback: RenderCallback) => void

export interface ViewOptions {
  defaultEngine?: string
  engines: Record<string, EngineFn>
  root?: string | string[]
}

const SLASHES = /[/\\]/g

export class View {
  ext: string
  name: string
  root?: string | string[]
  defaultEngine?: string
  engine!: EngineFn
  path?: string

  private constructor(name: string, options: ViewOptions) {
    this.defaultEngine = options.defaultEngine
    this.ext = extnameSync(name)
    this.name = name
    this.root = options.root
  }

  /** Async factory: loading an engine module and stat-ing candidate paths both await. */
  static async create(name: string, options: ViewOptions): Promise<View> {
    const view = new View(name, options)

    if (!view.ext && !view.defaultEngine) {
      throw new Error('No default engine was specified and no extension was provided.')
    }

    let fileName = name
    if (!view.ext) {
      view.ext = view.defaultEngine?.startsWith('.') ? view.defaultEngine : `.${view.defaultEngine}`
      fileName += view.ext
    }

    if (!options.engines[view.ext]) {
      const mod = view.ext.slice(1)
      const imported = (await import(/* @vite-ignore */ mod)) as { __express?: EngineFn }
      const fn = imported.__express
      if (typeof fn !== 'function') {
        throw new Error(`Module "${mod}" does not provide a view engine.`)
      }
      options.engines[view.ext] = fn
    }

    view.engine = options.engines[view.ext] as EngineFn
    view.path = await view.lookup(fileName)
    return view
  }

  async lookup(name: string): Promise<string | undefined> {
    const roots = Array.isArray(this.root) ? this.root : [this.root ?? '.']
    for (const root of roots) {
      const loc = await resolvePath(root, name)
      const parts = loc.split(SLASHES)
      const file = parts.pop() as string
      const dir = parts.join('/')
      const found = await this.resolve(dir, file)
      if (found) return found
    }
    return undefined
  }

  async resolve(dir: string, file: string): Promise<string | undefined> {
    const direct = await joinPath(dir, file)
    if ((await statFile(direct))?.isFile) return direct

    const base = file.endsWith(this.ext) ? file.slice(0, -this.ext.length) : file
    const indexed = await joinPath(dir, base, `index${this.ext}`)
    if ((await statFile(indexed))?.isFile) return indexed

    return undefined
  }

  render(options: object, callback: RenderCallback): void {
    if (!this.path) {
      callback(new Error(`Failed to lookup view "${this.name}"`))
      return
    }
    this.engine(this.path, options, callback)
  }
}

function extnameSync(name: string): string {
  const dot = name.lastIndexOf('.')
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  return dot > slash ? name.slice(dot) : ''
}

export async function isAbsoluteView(path: string): Promise<boolean> {
  return isAbsolutePath(path)
}
