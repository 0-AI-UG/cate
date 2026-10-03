// The files runtime: path scope, file operations, watching, search and open
// buffers of one workspace, plus the `file` and `search` capability
// implementations. Files are served while the workspace is untrusted (9.2),
// so nothing here asks for trust.

import fs from 'node:fs/promises'
import path from 'node:path'
import { RpcError } from '@kernel/rpc/contract'
import type { CapabilityImpl, StreamSink } from '@kernel/rpc/runtime'
import { KeyedLock } from '@kernel/state/contract'
import type { Logger } from '@kernel/log/contract'
import type { DataPaths } from '@runtime/data/runtime'
import { ensureCateGitignore } from '@workspace/lifecycle/runtime'
import {
  FILE_EXCLUSIONS,
  base64ToBytes,
  bytesToBase64,
  cateTempDir,
  contentHash,
  pathHasPrefix,
  pathKey,
  type FileEntry,
  type FileSearchResult,
  type FileStat,
  type FileText,
  type FsChange,
  type FsChangeType,
  type ImportEntry,
  type ImportResult,
  type SearchDone,
  type SearchFileResult,
  type SearchOptions,
  type fileCapability,
  type searchCapability,
} from '../contract'
import * as Y from 'yjs'
import { createPathScope, type PathScope } from './pathScope'
import { createWatchPool, type WatchPool, type WatchPoolDeps } from './watchPool'
import { createBufferService, type BufferService } from './buffers'
import { ByteInput } from './byteInput'
import { createFileServer } from './fileServer'
import { copyInto, moveToTrash, nextAvailableName, readBytesOrNull, readDir, removeEntry, searchFileNames, statEntry, writeAtomic } from './fileOps'
import { runRipgrepSearch, type SearchCallbacks, type SearchHandle } from './search/engine'

export interface FilesRuntimeDeps {
  /** Canonical workspace root. */
  root: string
  dataPaths: DataPaths
  log?: Logger
  /** Names hidden from listings, search and the watcher. */
  exclusions?: readonly string[]
  /** ripgrep binary; defaults to the one beside the daemon's node. */
  rgPath?: string
  /** Test seams. */
  watcher?: WatchPoolDeps
  trash?: (safePath: string) => Promise<boolean>
  buffers?: { persistDelayMs?: number; settleMs?: number }
}

export interface FilesRuntime {
  readonly paths: PathScope
  readonly buffers: BufferService
  /** The per-path write queue (13.3). Other modules writing workspace files
   *  go through it too. */
  readonly lock: KeyedLock
  read(p: string): Promise<FileText>
  readBinary(p: string): Promise<Uint8Array>
  write(p: string, content: string | Uint8Array, baseHash?: string | null): Promise<{ path: string; hash: string }>
  readDir(p: string): Promise<FileEntry[]>
  stat(p: string): Promise<FileStat>
  remove(p: string): Promise<void>
  trash(p: string): Promise<{ permanent: boolean }>
  rename(from: string, to: string): Promise<{ path: string }>
  /** Every successful `rename`, so open editors can follow their file. */
  onMoved(listener: (from: string, to: string) => void): () => void
  mkdir(p: string): Promise<void>
  copy(p: string, destDir: string): Promise<{ path: string }>
  /** The `.cate/tmp` of the checkout holding `near` (the root by default),
   *  created (with `.cate/.gitignore`) if missing. Rejects a `near` that no
   *  checkout holds (`paths.destination`). */
  tempDir(near?: string): Promise<string>
  /** A loopback URL of the runtime's machine serving the file (`fileServer`),
   *  so a browser panel loads it through loopback routing. */
  serveUrl(p: string): Promise<string>
  /** Watches under `p`; `onChange` gets absolute paths. */
  watch(p: string, onChange: (changedPath: string, type: FsChangeType) => void): () => void
  searchFiles(query: string, opts?: { root?: string; maxResults?: number }): Promise<FileSearchResult[]>
  searchContent(options: SearchOptions, callbacks: SearchCallbacks, root?: string): SearchHandle
  /** Where browser downloads are stored. */
  downloadsDir(): string
  /** Where screenshots are stored. */
  screenshotsDir(): string
  setExclusions(names: readonly string[]): Promise<void>
  dispose(): Promise<void>
}

/** The rg shipped in the runtime tarball, next to the bundled node. */
function daemonRgPath(): string {
  return path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'rg.exe' : 'rg')
}

function conflict(hash: string | null): RpcError {
  return new RpcError('conflict', 'The file changed on disk since it was read', { hash })
}

export function createFilesRuntime(deps: FilesRuntimeDeps): FilesRuntime {
  const exclusions = new Set(deps.exclusions ?? FILE_EXCLUSIONS)
  const paths = createPathScope({ root: deps.root, dataDir: deps.dataPaths.dir })
  const lock = new KeyedLock()
  const pool: WatchPool = createWatchPool(
    () => exclusions,
    (root, err) => deps.log?.warn('watcher failed', root, err),
    deps.watcher,
  )
  const buffers = createBufferService({
    paths,
    watch: (dir, onChange) => pool.subscribe(dir, onChange),
    dir: deps.dataPaths.buffers,
    lock,
    log: deps.log,
    ...deps.buffers,
  })
  const rgPath = deps.rgPath ?? daemonRgPath()
  const locked = <T>(p: string, fn: () => Promise<T>) => lock.run(pathKey(p), fn)
  const moveListeners = new Set<(from: string, to: string) => void>()
  // Pages may fetch anything the server serves, so it never serves the
  // workspace data (secrets, pairings): only the root, checkouts and grants.
  const server = createFileServer({
    strict: async (p) => {
      const safe = await paths.strict(p)
      if (pathHasPrefix(safe, paths.dataDir)) throw new RpcError('rejected', 'Not a workspace file')
      return safe
    },
  })

  const write: FilesRuntime['write'] = async (p, content, baseHash) => {
    const safe = await paths.forCreation(p)
    return locked(safe, async () => {
      if (baseHash !== undefined) {
        const disk = await readBytesOrNull(safe)
        const diskHash = disk ? contentHash(disk) : null
        if (diskHash !== baseHash) throw conflict(diskHash)
      }
      await writeAtomic(safe, content)
      return { path: safe, hash: contentHash(content) }
    })
  }

  return {
    paths,
    buffers,
    lock,

    async read(p) {
      const bytes = await fs.readFile(await paths.strict(p))
      return { content: bytes.toString('utf-8'), hash: contentHash(bytes) }
    },
    async readBinary(p) {
      return new Uint8Array(await fs.readFile(await paths.strict(p)))
    },
    write,
    async readDir(p) {
      return readDir(await paths.strict(p), exclusions)
    },
    async stat(p) {
      return statEntry(await paths.strict(p))
    },
    async remove(p) {
      const safe = await paths.entry(p)
      await locked(safe, () => removeEntry(safe))
    },
    async trash(p) {
      const safe = await paths.entry(p)
      return locked(safe, async () => {
        await fs.lstat(safe)
        if (await (deps.trash ?? moveToTrash)(safe)) return { permanent: false }
        await removeEntry(safe)
        return { permanent: true }
      })
    },
    async rename(from, to) {
      const src = await paths.entry(from)
      await paths.destination(path.dirname(to))
      const dest = await paths.forCreation(to)
      await locked(src, () => fs.rename(src, dest))
      for (const listener of [...moveListeners]) {
        try { listener(src, dest) } catch (err) { deps.log?.warn('move listener failed', err) }
      }
      return { path: dest }
    },
    onMoved(listener) {
      moveListeners.add(listener)
      return () => { moveListeners.delete(listener) }
    },
    async mkdir(p) {
      await fs.mkdir(await paths.forCreation(p), { recursive: true })
    },
    async copy(p, destDir) {
      return { path: await copyInto(await paths.strict(p), await paths.destination(destDir)) }
    },
    async tempDir(near = paths.root) {
      const checkout = paths.checkoutOf(await paths.destination(near))!
      await ensureCateGitignore(checkout)
      const dir = await paths.forCreation(cateTempDir(checkout))
      await fs.mkdir(dir, { recursive: true })
      return dir
    },
    serveUrl: (p) => server.urlFor(p),
    watch(p, onChange) {
      return pool.subscribe(paths.resolve(p), onChange)
    },
    async searchFiles(query, opts = {}) {
      const root = await paths.strict(opts.root ?? paths.root)
      return searchFileNames(root, query, exclusions, opts.maxResults)
    },
    searchContent(options, callbacks, root) {
      return runRipgrepSearch(rgPath, options, paths.resolve(root ?? paths.root), [...exclusions], callbacks)
    },
    downloadsDir: () => deps.dataPaths.downloads,
    screenshotsDir: () => deps.dataPaths.screenshots,
    async setExclusions(names) {
      exclusions.clear()
      for (const name of names) exclusions.add(name)
      await pool.refresh()
    },
    async dispose() {
      await server.close()
      await buffers.dispose()
      await pool.closeAll()
      paths.dispose()
    },
  }
}

// ---- capability implementations -------------------------------------------

const WATCH_BATCH_MS = 16
const READ_CHUNK = 256 * 1024

/** Reads the bytes a client writes to `sink`. */
function inputOf(sink: StreamSink<unknown, unknown>, signal: AbortSignal): ByteInput {
  const input = new ByteInput()
  sink.onInput((chunk) => input.push(chunk))
  signal.addEventListener('abort', () => input.close(new RpcError('gone', 'Upload stopped')))
  return input
}

/** A relative upload path: `/`-separated, no empty, `.` or `..` segments. */
function uploadSegments(rel: string): string[] | null {
  if (typeof rel !== 'string' || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return null
  const segments = rel.split('/')
  if (segments.some((s) => !s || s === '.' || s === '..' || s.includes('\\') || s.includes('\0'))) return null
  return segments
}

async function writeStream(file: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
  const handle = await fs.open(file, 'wx')
  try {
    for await (const chunk of chunks) await handle.write(chunk)
  } finally {
    await handle.close()
  }
}

/** Writes exactly `size` streamed bytes to a fresh file in a data dir, named
 *  `<time>-<name>` after the sanitized base name. */
async function storeInData(dir: string, name: unknown, fallback: string, size: number, input: ByteInput): Promise<string> {
  if (!(Number.isSafeInteger(size) && size >= 0)) throw new RpcError('rejected', 'Invalid size')
  await fs.mkdir(dir, { recursive: true })
  const base = path.basename(String(name ?? '')).replace(/[\0/\\]/g, '_') || fallback
  const target = path.join(dir, `${Date.now()}-${base === '.' || base === '..' ? fallback : base}`)
  await writeStream(target, input.take(size)).catch(async (err) => {
    await fs.rm(target, { force: true })
    throw err
  })
  return target
}

async function importEntries(files: FilesRuntime, destDir: string, entries: ImportEntry[], input: ByteInput): Promise<ImportResult> {
  if (!Array.isArray(entries)) throw new RpcError('rejected', 'entries must be a list')
  for (const entry of entries) {
    if (entry.kind === 'file' && !(Number.isSafeInteger(entry.size) && entry.size >= 0)) {
      throw new RpcError('rejected', 'Invalid entry size')
    }
  }
  const safeDest = await files.paths.destination(destDir)
  // Each dropped item gets one free top-level name on its first entry; null
  // marks an item that failed (its later entries are skipped).
  const tops = new Map<string, string | null>()
  let invalid = 0
  for (const entry of entries) {
    const size = entry.kind === 'file' ? entry.size : 0
    let consumed = 0
    const segments = uploadSegments(entry.path)
    if (!segments) {
      invalid++
      await input.skip(size)
      continue
    }
    const [first, ...rest] = segments
    let name = tops.get(first)
    try {
      if (name === null) throw new Error('item failed')
      if (name === undefined) {
        name = await nextAvailableName(safeDest, first, false)
        tops.set(first, name)
      }
      const target = await files.paths.forCreation(path.join(safeDest, name, ...rest))
      if (entry.kind === 'dir') {
        await fs.mkdir(target, { recursive: true })
      } else {
        await fs.mkdir(path.dirname(target), { recursive: true })
        await writeStream(target, (async function* () {
          for await (const chunk of input.take(size)) {
            consumed += chunk.length
            yield chunk
          }
        })())
      }
    } catch {
      if (name) await fs.rm(path.join(safeDest, name), { recursive: true, force: true }).catch(() => {})
      tops.set(first, null)
      await input.skip(size - consumed)
    }
  }
  const names = [...tops.values()]
  return {
    created: names.filter((n): n is string => n !== null).map((n) => path.join(safeDest, n)),
    failed: names.filter((n) => n === null).length + invalid,
  }
}

export function fileCapabilityImpl(files: FilesRuntime): CapabilityImpl<typeof fileCapability> {
  return {
    read: ({ path: p }) => files.read(p),
    write: ({ path: p, content, baseHash }) => files.write(p, content, baseHash),
    readDir: ({ path: p }) => files.readDir(p),
    stat: ({ path: p }) => files.stat(p),
    remove: ({ path: p }) => files.remove(p),
    trash: ({ path: p }) => files.trash(p),
    rename: ({ from, to }) => files.rename(from, to),
    mkdir: ({ path: p }) => files.mkdir(p),
    copy: ({ path: p, destDir }) => files.copy(p, destDir),
    tempDir: async ({ near }) => ({ path: await files.tempDir(near) }),
    serveUrl: async ({ path: p }) => ({ url: await files.serveUrl(p) }),
    grant: async ({ path: p }) => ({ path: await files.paths.grant(p) }),
    saveBuffer: ({ path: p }) => files.buffers.save(p),
    resolveBuffer: ({ path: p, resolution }) => files.buffers.resolveConflict(p, resolution),

    readBinary: async ({ path: p }, sink, ctx) => {
      const bytes = await files.readBinary(p)
      for (let offset = 0; offset < bytes.length; offset += READ_CHUNK) {
        if (ctx.signal.aborted) return
        if (!sink.bytes(bytes.subarray(offset, offset + READ_CHUNK))) await sink.drain()
      }
      sink.end({ size: bytes.length, hash: contentHash(bytes) })
    },

    writeBinary: async ({ path: p, size, baseHash }, sink, ctx) => {
      if (!(Number.isSafeInteger(size) && size >= 0)) throw new RpcError('rejected', 'Invalid size')
      const safe = await files.paths.forCreation(p)
      const bytes = await inputOf(sink, ctx.signal).readAll(size)
      sink.end(await files.write(safe, bytes, baseHash))
    },

    importEntries: async ({ destDir, entries }, sink, ctx) => {
      sink.end(await importEntries(files, destDir, entries, inputOf(sink, ctx.signal)))
    },

    storeDownload: async ({ filename, size }, sink, ctx) => {
      sink.end({ path: await storeInData(files.downloadsDir(), filename, 'download', size, inputOf(sink, ctx.signal)) })
    },

    storeScreenshot: async ({ name, size }, sink, ctx) => {
      sink.end({ path: await storeInData(files.screenshotsDir(), name, 'screenshot.png', size, inputOf(sink, ctx.signal)) })
    },

    watch: ({ path: p }, sink) => {
      let pending = new Map<string, FsChange>()
      let timer: ReturnType<typeof setTimeout> | null = null
      const flush = () => {
        timer = null
        const batch = [...pending.values()]
        pending = new Map()
        if (batch.length) sink.emit(batch)
      }
      const stop = files.watch(p, (changedPath, type) => {
        pending.set(changedPath, { path: changedPath, type })
        timer ??= setTimeout(flush, WATCH_BATCH_MS)
      })
      return () => {
        stop()
        if (timer) clearTimeout(timer)
      }
    },

    buffer: async ({ path: p, stateVector }, sink) => {
      const handle = await files.buffers.open(p)
      const token = Symbol('buffer-subscriber')
      try {
        sink.emit({ kind: 'state', state: handle.state() })
        sink.bytes(Y.encodeStateAsUpdate(handle.doc, stateVector ? base64ToBytes(stateVector) : undefined))
        sink.emit({ kind: 'sync', stateVector: bytesToBase64(Y.encodeStateVector(handle.doc)) })
      } catch (err) {
        handle.close()
        throw err
      }
      const offUpdate = handle.onUpdate((update, origin) => { if (origin !== token) sink.bytes(update) })
      const offState = handle.subscribe((state) => sink.emit({ kind: 'state', state }))
      sink.onInput((update) => {
        try {
          handle.applyUpdate(update, token)
        } catch (err) {
          sink.fail(new RpcError('rejected', `Bad buffer update: ${err instanceof Error ? err.message : err}`))
        }
      })
      return () => {
        offUpdate()
        offState()
        handle.close()
      }
    },
  }
}

export function searchCapabilityImpl(files: FilesRuntime): CapabilityImpl<typeof searchCapability> {
  return {
    files: ({ root, query, maxResults }) => files.searchFiles(String(query ?? '').trim(), { root, maxResults }),
    content: ({ root, options }, sink: StreamSink<SearchFileResult[], SearchDone>) => {
      const opts = sanitizeSearch(options)
      if (!opts.query.trim()) {
        sink.end({ stats: { matches: 0, files: 0, truncated: false } })
        return
      }
      const handle = files.searchContent(opts, {
        onBatch: (batch) => sink.emit(batch),
        onDone: (stats, error) => sink.end(error ? { stats, error } : { stats }),
      }, root)
      return () => handle.cancel()
    },
  }
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.max(min, Math.min(max, n))
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** Coerces client input into safe search options. */
export function sanitizeSearch(raw: Partial<SearchOptions> | undefined): SearchOptions {
  return {
    query: String(raw?.query ?? ''),
    isRegex: !!raw?.isRegex,
    matchCase: !!raw?.matchCase,
    wholeWord: !!raw?.wholeWord,
    includes: stringArray(raw?.includes),
    excludes: stringArray(raw?.excludes),
    respectIgnore: raw?.respectIgnore !== false,
    maxResults: clampInt(raw?.maxResults, 2000, 1, 20000),
  }
}
