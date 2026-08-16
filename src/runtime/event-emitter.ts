/**
 * Minimal EventEmitter. An Express `app` is an EventEmitter (`app.on('mount', ...)` is
 * public API), but `node:events` is not always available on the edge.
 */

type Listener = (...args: unknown[]) => void

interface WrappedListener extends Listener {
  listener?: Listener
}

export class MiniEmitter {
  #events = new Map<string | symbol, WrappedListener[]>()
  #maxListeners = 10

  #bucket(event: string | symbol): WrappedListener[] {
    let a = this.#events.get(event)
    if (!a) {
      a = []
      this.#events.set(event, a)
    }
    return a
  }

  on(event: string | symbol, listener: Listener): this {
    this.#bucket(event).push(listener)
    return this
  }

  addListener(event: string | symbol, listener: Listener): this {
    return this.on(event, listener)
  }

  prependListener(event: string | symbol, listener: Listener): this {
    this.#bucket(event).unshift(listener)
    return this
  }

  once(event: string | symbol, listener: Listener): this {
    const wrapper: WrappedListener = (...args) => {
      this.removeListener(event, wrapper)
      listener.apply(this, args)
    }
    wrapper.listener = listener
    return this.on(event, wrapper)
  }

  prependOnceListener(event: string | symbol, listener: Listener): this {
    const wrapper: WrappedListener = (...args) => {
      this.removeListener(event, wrapper)
      listener.apply(this, args)
    }
    wrapper.listener = listener
    return this.prependListener(event, wrapper)
  }

  removeListener(event: string | symbol, listener: Listener): this {
    const a = this.#events.get(event)
    if (!a) return this
    const i = a.findIndex((f) => f === listener || f.listener === listener)
    if (i >= 0) a.splice(i, 1)
    if (a.length === 0) this.#events.delete(event)
    return this
  }

  off(event: string | symbol, listener: Listener): this {
    return this.removeListener(event, listener)
  }

  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) this.#events.clear()
    else this.#events.delete(event)
    return this
  }

  /** Returns the original functions, not wrappers: `unpipe` matches listeners by name. */
  listeners(event: string | symbol): Listener[] {
    return (this.#events.get(event) ?? []).map((f) => f.listener ?? f)
  }

  rawListeners(event: string | symbol): Listener[] {
    return (this.#events.get(event) ?? []).slice()
  }

  listenerCount(event: string | symbol): number {
    return this.#events.get(event)?.length ?? 0
  }

  eventNames(): (string | symbol)[] {
    return [...this.#events.keys()]
  }

  setMaxListeners(n: number): this {
    this.#maxListeners = n
    return this
  }

  getMaxListeners(): number {
    return this.#maxListeners
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    const a = this.#events.get(event)
    if (!a || a.length === 0) return false
    // Copy first so a listener may remove itself while emitting
    for (const f of a.slice()) f.apply(this, args)
    return true
  }
}

/**
 * Mixes the EventEmitter API onto a plain object, like Express does.
 *
 * `_events` / `_eventsCount` / `_maxListeners` are Node internals that some libraries read
 * directly, so they are exposed too.
 */
export function mixinEmitter<T extends object>(target: T): T {
  const emitter = new MiniEmitter()
  const proto = MiniEmitter.prototype as unknown as Record<string, unknown>
  for (const name of Object.getOwnPropertyNames(proto)) {
    if (name === 'constructor') continue
    const fn = proto[name]
    if (typeof fn !== 'function') continue
    Object.defineProperty(target, name, {
      value: (fn as (...a: unknown[]) => unknown).bind(emitter),
      writable: true,
      configurable: true,
      enumerable: false,
    })
  }

  Object.defineProperties(target, {
    _events: {
      configurable: true,
      enumerable: false,
      get: () => {
        const out: Record<string, unknown> = Object.create(null)
        for (const name of emitter.eventNames()) {
          if (typeof name === 'string') out[name] = emitter.rawListeners(name)
        }
        return out
      },
    },
    _eventsCount: {
      configurable: true,
      enumerable: false,
      get: () => emitter.eventNames().length,
    },
    _maxListeners: {
      configurable: true,
      enumerable: false,
      get: () => emitter.getMaxListeners(),
      set: (n: number) => emitter.setMaxListeners(n),
    },
  })

  return target
}
