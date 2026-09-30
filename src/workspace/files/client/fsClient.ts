// The fs client: typed file and search calls on a workspace's runtime, with
// the byte-stream plumbing (binary reads and writes, dropped-file uploads,
// downloads) done once here. Portable: no Node, no Electron.

import { runtimeFor } from '@kernel/rpc/client'
import type { CapabilityProxy } from '@kernel/rpc/contract'
import type {
  FileEntry,
  FileSearchResult,
  FileStat,
  FileText,
  ImportEntry,
  ImportResult,
  SearchDone,
  SearchFileResult,
  SearchOptions,
  fileCapability,
  searchCapability,
} from '../contract'

type FileApi = CapabilityProxy<typeof fileCapability>
type SearchApi = CapabilityProxy<typeof searchCapability>

const WRITE_CHUNK = 256 * 1024

/** Bytes of one dropped file: all at once or as chunks. */
export type ByteSource = Uint8Array | (() => Promise<Uint8Array> | AsyncIterable<Uint8Array>)

/** A dropped entry. `path` is relative to the drop, `/`-separated; directories
 *  come before their contents. */
export type ImportSource =
  | { path: string; kind: 'dir' }
  | { path: string; kind: 'file'; size: number; bytes: ByteSource }

export interface ContentSearch {
  readonly done: Promise<SearchDone>
  cancel(): void
}

export interface FsClient {
  read(path: string): Promise<FileText>
  write(path: string, content: string, baseHash?: string | null): Promise<{ path: string; hash: string }>
  readBinary(path: string): Promise<Uint8Array>
  writeBinary(path: string, bytes: Uint8Array, baseHash?: string | null): Promise<{ path: string; hash: string }>
  readDir(path: string): Promise<FileEntry[]>
  stat(path: string): Promise<FileStat>
  remove(path: string): Promise<void>
  trash(path: string): Promise<{ permanent: boolean }>
  rename(from: string, to: string): Promise<{ path: string }>
  mkdir(path: string): Promise<void>
  copy(path: string, destDir: string): Promise<{ path: string }>
  grant(path: string): Promise<{ path: string }>
  importEntries(destDir: string, sources: ImportSource[]): Promise<ImportResult>
  storeDownload(filename: string, bytes: Uint8Array): Promise<{ path: string }>
  storeScreenshot(name: string, bytes: Uint8Array): Promise<{ path: string }>
  searchFiles(query: string, opts?: { root?: string; maxResults?: number }): Promise<FileSearchResult[]>
  searchContent(options: SearchOptions, onBatch: (files: SearchFileResult[]) => void, root?: string): ContentSearch
}

function writeChunked(write: (bytes: Uint8Array) => void, bytes: Uint8Array): void {
  for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK) write(bytes.subarray(offset, offset + WRITE_CHUNK))
}

async function sendSource(write: (bytes: Uint8Array) => void, source: ByteSource, size: number): Promise<void> {
  let sent = 0
  const send = (chunk: Uint8Array) => {
    if (sent + chunk.length > size) throw new Error('Dropped file is larger than declared')
    sent += chunk.length
    writeChunked(write, chunk)
  }
  const value = typeof source === 'function' ? await source() : source
  if (value instanceof Uint8Array) send(value)
  else for await (const chunk of value) send(chunk)
  if (sent !== size) throw new Error('Dropped file is smaller than declared')
}

export function createFsClient(file: FileApi, search: SearchApi): FsClient {
  return {
    read: (path) => file.read({ path }),
    write: (path, content, baseHash) => file.write(baseHash === undefined ? { path, content } : { path, content, baseHash }),
    async readBinary(path) {
      const sub = file.readBinary({ path })
      const chunks: Uint8Array[] = []
      sub.onBytes((chunk) => chunks.push(chunk.slice()))
      const { size } = await sub.done
      const out = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.length
      }
      return out
    },
    async writeBinary(path, bytes, baseHash) {
      const sub = file.writeBinary(baseHash === undefined ? { path, size: bytes.length } : { path, size: bytes.length, baseHash })
      writeChunked((chunk) => sub.write(chunk), bytes)
      return sub.done
    },
    readDir: (path) => file.readDir({ path }),
    stat: (path) => file.stat({ path }),
    remove: (path) => file.remove({ path }),
    trash: (path) => file.trash({ path }),
    rename: (from, to) => file.rename({ from, to }),
    mkdir: (path) => file.mkdir({ path }),
    copy: (path, destDir) => file.copy({ path, destDir }),
    grant: (path) => file.grant({ path }),
    async importEntries(destDir, sources) {
      const entries: ImportEntry[] = sources.map((s) => (s.kind === 'dir' ? { path: s.path, kind: 'dir' } : { path: s.path, kind: 'file', size: s.size }))
      const sub = file.importEntries({ destDir, entries })
      try {
        for (const source of sources) {
          if (source.kind === 'file') await sendSource((chunk) => sub.write(chunk), source.bytes, source.size)
        }
      } catch (err) {
        sub.cancel()
        throw err
      }
      return sub.done
    },
    async storeDownload(filename, bytes) {
      const sub = file.storeDownload({ filename, size: bytes.length })
      writeChunked((chunk) => sub.write(chunk), bytes)
      return sub.done
    },
    async storeScreenshot(name, bytes) {
      const sub = file.storeScreenshot({ name, size: bytes.length })
      writeChunked((chunk) => sub.write(chunk), bytes)
      return sub.done
    },
    searchFiles: (query, opts = {}) => search.files({ query, ...opts }),
    searchContent(options, onBatch, root) {
      const sub = search.content(root === undefined ? { options } : { root, options })
      sub.onEvent(onBatch)
      return { done: sub.done, cancel: () => sub.cancel() }
    },
  }
}

/** The fs client of an open workspace. */
export function fsClient(workspaceId: string): FsClient {
  const runtime = runtimeFor(workspaceId)
  return createFsClient(runtime.file, runtime.search)
}
