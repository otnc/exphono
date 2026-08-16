/**
 * Prints what is missing when the surface test fails. No assertions.
 */

import { createRequire } from 'node:module'
import { describe, it } from 'vitest'
import exphono from '../../src/index.js'

const require = createRequire(import.meta.url)
const express5 = require('express')
const express4 = require('express4')

const NOISE = new Set([
  'length',
  'name',
  'arguments',
  'caller',
  'prototype',
  'constructor',
  'apply',
  'bind',
  'call',
  'toString',
])

function ownKeys(o: unknown): string[] {
  return o ? Object.getOwnPropertyNames(o).filter((k) => !NOISE.has(k)) : []
}

function allKeys(o: unknown): Set<string> {
  const s = new Set<string>()
  let cur = o
  while (cur && cur !== Object.prototype && cur !== Function.prototype) {
    for (const k of Object.getOwnPropertyNames(cur)) s.add(k)
    cur = Object.getPrototypeOf(cur)
  }
  return s
}

function reportOwn(label: string, expected: unknown, actual: unknown): void {
  const have = allKeys(actual)
  const missing = ownKeys(expected).filter((k) => !have.has(k))
  console.log(`\n── ${label} — own props of express, missing in exphono: ${missing.length}`)
  if (missing.length) console.log(`   ${missing.sort().join(', ')}`)
}

describe('gap report', () => {
  it('prints what is missing', () => {
    reportOwn('module (express 5)', express5, exphono)
    reportOwn('module (express 4)', express4, exphono)
    reportOwn('app (express 5)', express5(), exphono())
    reportOwn('app proto (express 5)', Object.getPrototypeOf(express5()), exphono())
    reportOwn('request (express 5)', express5.request, exphono.request)
    reportOwn('response (express 5)', express5.response, exphono.response)
    reportOwn('Router (express 5)', express5.Router(), exphono.Router())
    reportOwn(
      'Router proto (express 5)',
      Object.getPrototypeOf(express5.Router()),
      exphono.Router(),
    )
    reportOwn('Route (express 5)', new express5.Route('/x'), new exphono.Route('/x'))
    reportOwn(
      'Route proto (express 5)',
      Object.getPrototypeOf(new express5.Route('/x')),
      new exphono.Route('/x'),
    )
  })
})
