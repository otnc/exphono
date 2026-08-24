/**
 * Filesystem access for `express.static`, `res.sendFile` and `res.download`.
 *
 * Aliased to `files.edge.ts` in the edge build so `node:fs` never reaches a Workers
 * bundle. Bundlers follow dynamic imports, so this has to be a build-time split.
 */

export interface FileStat {
  size: number
  mtime: Date
  isFile: boolean
  isDirectory: boolean
}

export interface FileRange {
  start: number
  end: number
}

export const hasFileSystem = true

export async function statFile(path: string): Promise<FileStat | null> {
  const { stat } = await import('node:fs/promises')
  try {
    const s = await stat(path)
    return {
      size: s.size,
      mtime: s.mtime,
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
    }
  } catch {
    return null
  }
}

export async function readFileStream(path: string, range?: FileRange): Promise<ReadableStream> {
  const { createReadStream } = await import('node:fs')
  const { Readable } = await import('node:stream')
  const stream = createReadStream(path, range ? { start: range.start, end: range.end } : undefined)
  return Readable.toWeb(stream) as ReadableStream
}

export async function resolvePath(...parts: string[]): Promise<string> {
  const { resolve } = await import('node:path')
  return resolve(...parts)
}

export async function joinPath(...parts: string[]): Promise<string> {
  const { join } = await import('node:path')
  return join(...parts)
}

export async function isAbsolutePath(path: string): Promise<boolean> {
  const { isAbsolute } = await import('node:path')
  return isAbsolute(path)
}

export async function extname(path: string): Promise<string> {
  const { extname: ext } = await import('node:path')
  return ext(path)
}

export async function cwd(): Promise<string> {
  return process.cwd()
}
