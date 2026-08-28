/**
 * URL encoding for `Location` and `Link` headers, matching the `encodeurl` package.
 *
 * `encodeURI` is not a substitute: it re-encodes the `%` in an already-encoded sequence,
 * turning `%e2%98%83` into `%25e2%2598%2583`.
 */

/**
 * Characters left alone: `!`, `#`-`;`, `=`, `?`-`_`, `a`-`z`, `|`, `~`. The second branch
 * catches a `%` that does not start a valid escape, so those get encoded.
 */
const ENCODE_CHARS =
  /(?:[^\x21\x23-\x3B\x3D\x3F-\x5F\x61-\x7A\x7C\x7E]|%(?:[^0-9A-Fa-f]|[0-9A-Fa-f][^0-9A-Fa-f]|$))+/g

/** A lone surrogate cannot be encoded, so it is replaced with U+FFFD first. */
const UNMATCHED_SURROGATE =
  /(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF]([^\uDC00-\uDFFF]|$)/g

export function encodeUrl(url: unknown): string {
  return String(url).replace(UNMATCHED_SURROGATE, '$1�$2').replace(ENCODE_CHARS, encodeURI)
}
