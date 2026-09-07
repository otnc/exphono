/**
 * ETag generation for `res.send()`, matching the `etag` npm package byte-for-byte.
 *
 * `res.send()` is synchronous, but WebCrypto only offers an async digest, so this is a
 * plain SHA-1 implementation rather than a `crypto.subtle` call.
 */

import { toBase64 } from './hmac.js'

function rotl(x: number, n: number): number {
  return (x << n) | (x >>> (32 - n))
}

function sha1(message: Uint8Array): Uint8Array {
  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0

  const bitLength = message.length * 8
  const padded = new Uint8Array((((message.length + 8) >> 6) + 1) * 64)
  padded.set(message)
  padded[message.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 4, bitLength >>> 0, false)
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000), false)

  const w = new Uint32Array(80)

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false)
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(
        (w[i - 3] as number) ^ (w[i - 8] as number) ^ (w[i - 14] as number) ^ (w[i - 16] as number),
        1,
      )
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4

    for (let i = 0; i < 80; i++) {
      let f: number
      let k: number
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }

      const temp = (rotl(a, 5) + f + e + k + (w[i] as number)) >>> 0
      e = d
      d = c
      c = rotl(b, 30)
      b = a
      a = temp
    }

    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }

  const out = new Uint8Array(20)
  const outView = new DataView(out.buffer)
  outView.setUint32(0, h0, false)
  outView.setUint32(4, h1, false)
  outView.setUint32(8, h2, false)
  outView.setUint32(12, h3, false)
  outView.setUint32(16, h4, false)
  return out
}

const EMPTY_ETAG = '"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"'

const encoder = new TextEncoder()

/** A strong ETag for the given body, matching the `etag` package's default (non-weak) form. */
export function strongEtag(body: Uint8Array | string): string {
  const bytes = typeof body === 'string' ? encoder.encode(body) : body
  if (bytes.byteLength === 0) return EMPTY_ETAG
  const hash = toBase64(sha1(bytes)).slice(0, 27)
  return `"${bytes.byteLength.toString(16)}-${hash}"`
}

/** A weak ETag (`W/` prefixed) for the given body — Express's default `app.set('etag', ...)`. */
export function weakBodyEtag(body: Uint8Array | string): string {
  return `W/${strongEtag(body)}`
}
