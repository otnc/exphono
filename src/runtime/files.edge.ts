/**
 * Edge replacement for `files.ts`, aliased in at build time. Workers have no filesystem;
 * static assets come from a binding instead.
 */

import { fail } from '../diagnostics.js'

export type { FileRange, FileStat } from './files.js'

export const hasFileSystem = false

export function statFile(): never {
  return fail('EXPHONO_E003', 'statFile')
}

export function readFileStream(): never {
  return fail('EXPHONO_E003', 'readFileStream')
}

export async function resolvePath(...parts: string[]): Promise<string> {
  return normalize(parts.join('/'))
}

export async function joinPath(...parts: string[]): Promise<string> {
  return normalize(parts.join('/'))
}

export async function isAbsolutePath(path: string): Promise<boolean> {
  return path.startsWith('/')
}

export async function extname(path: string): Promise<string> {
  const base = path.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot)
}

export async function cwd(): Promise<string> {
  return '/'
}

function normalize(path: string): string {
  const absolute = path.startsWith('/')
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return (absolute ? '/' : '') + out.join('/')
}
