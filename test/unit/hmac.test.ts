import { createRequire } from 'node:module'
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hmacSha256, sign, unsign } from '../../src/utils/hmac.js'

const require = createRequire(import.meta.url)
const reference = require('cookie-signature')

describe('hmacSha256 matches node:crypto', () => {
  for (const [key, data] of [
    ['secret', 'hello'],
    ['', ''],
    ['a'.repeat(100), 'short'],
    ['k', 'x'.repeat(1000)],
    ['🔑', 'multibyte 値'],
  ] as const) {
    it(`key=${key.slice(0, 12)} data=${data.slice(0, 12)}`, () => {
      const mine = Buffer.from(hmacSha256(key, data)).toString('hex')
      const node = createHmac('sha256', key).update(data).digest('hex')
      expect(mine).toBe(node)
    })
  }
})

describe('sign matches cookie-signature', () => {
  for (const value of ['hello', 'a.b.c', '', 'sess:abc123']) {
    it(JSON.stringify(value), () => {
      expect(sign(value, 'my secret')).toBe(reference.sign(value, 'my secret'))
    })
  }

  it('round-trips', () => {
    expect(unsign(sign('payload', 's'), 's')).toBe('payload')
  })

  it('rejects a tampered value', () => {
    expect(unsign(`${sign('payload', 's')}x`, 's')).toBe(false)
    expect(unsign(sign('payload', 's'), 'other')).toBe(false)
  })
})
