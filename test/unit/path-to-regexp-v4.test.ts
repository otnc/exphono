import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pathToRegexpV4 } from '../../src/router/path-to-regexp-v4.js'

const require = createRequire(import.meta.url)
const expressDir = dirname(require.resolve('express4'))
const reference = createRequire(`${expressDir}/`)('path-to-regexp') as (
  path: string,
  keys: { name: string | number }[],
  options: { strict: boolean; end: boolean; sensitive: boolean },
) => RegExp

const PATHS = [
  '/',
  '/user/:id',
  '/user/:id?',
  '/user/:id/:op?',
  '/files/*',
  '/user/*.json',
  '/*/*',
  '/:name.:ext?',
  '/:a(\\d+)/:b',
  '/:name*',
  '/user/(\\d+)',
  '/user/\\(:id\\)',
  '/.:name?',
  '/api/(v1|v2)/items',
  '/blog/:year/:month?/:slug',
]

describe('pathToRegexpV4 matches path-to-regexp@0.1.x', () => {
  for (const path of PATHS) {
    for (const strict of [false, true]) {
      for (const end of [false, true]) {
        it(`${path} (strict=${strict}, end=${end})`, () => {
          const options = { strict, end, sensitive: false }
          const keys: { name: string | number }[] = []
          const expected = reference(path, keys, options)
          const actual = pathToRegexpV4(path, options)
          expect(actual.regexp.source).toBe(expected.source)
          expect(actual.regexp.flags).toBe(expected.flags)
          expect(actual.keys.map((k) => k.name)).toEqual(keys.map((k) => k.name))
        })
      }
    }
  }
})
