// =============================================================================
// Filesystem IPC handlers — file read/write and directory watching
// =============================================================================

import fs from 'fs/promises'
import path from 'path'
import { watch, FSWatcher } from 'chokidar'
import { ipcMain } from 'electron'
import log from '../logger'
import { consumeScopedWriteAllowance, validatePathStrict, validatePathForCreation } from './pathValidation'
import {
  FS_READ_FILE,
  FS_WRITE_FILE,
  FS_READ_DIR,
  FS_WATCH_START,
  FS_WATCH_STOP,
  FS_WATCH_EVENT,
  FS_STAT,
  FS_DELETE,
  FS_RENAME,
  FS_MKDIR,
  FS_COPY,
  FS_IMPORT_ENTRIES,
  FS_SEARCH,
  FS_READ_BINARY,
} from '../../shared/ipc-channels'
import { FileTreeNode, FileSearchResult, FileSearchOptions, FILE_EXCLUSIONS } from '../../shared/types'
import { sendToWindow, windowFromEvent } from '../windowRegistry'

// Set of exclusion names for fast lookup
const exclusionSet = new Set(FILE_EXCLUSIONS)

// ---------------------------------------------------------------------------
// Shared watcher pool — one chokidar watcher per normalised directory path,
// shared across any number of windows/requesters via reference counting.
// Per-requester event listeners are tracked separately so each window only
// receives its own events and cleanup is precise.
// ---------------------------------------------------------------------------

interface SubscriberEntry {
  /** Only events whose path startsWith this prefix are dispatched. */
  prefix: string
  /** Per-subscriber dispatch function (a single event at a time). */
  dispatch: (type: string, filePath: string) => void
  /** Cancel any pending trailing-edge flush (called from watchStop). */
  cancelFlush: () => void
}

interface SharedWatcher {
  watcher: FSWatcher
  refCount: number
  /** Per-subscriber entries keyed by an opaque subscriber key. */
  subscribers: Map<string, SubscriberEntry>
}

/** Shared watcher pool keyed by normalised absolute directory path. */
const sharedWatchers: Map<string, SharedWatcher> = new Map()

/** Per-requester key -> normalised path, so watchStop can look up the shared entry. */
const watcherKeys: Map<string, string> = new Map()

function watcherKey(windowId: number, dirPath: string): string {
  return `${windowId}:${dirPath}`
}

/** Trailing-edge debounce window for coalescing chokidar bursts. */
const DISPATCH_DEBOUNCE_MS = 16

/**
 * True iff `filePath` is `prefix` itself or lives under it. Comparison is a
 * straightforward string-prefix check; chokidar emits absolute, OS-normalised
 * paths so we trust them as-is (matching how `dirPath` is stored upstream).
 */
function pathHasPrefix(filePath: string, prefix: string): boolean {
  if (filePath === prefix) return true
  if (!filePath.startsWith(prefix)) return false
  const next = filePath.charCodeAt(prefix.length)
  // 47 = '/', 92 = '\\'
  return next === 47 || next === 92
}

async function readFile(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf-8')
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, content, 'utf-8')
}

/**
 * Read a single level of a directory, building FileTreeNode[].
 * Matches FileTreeModel.buildNodes logic from Swift:
 * - Skip hidden files (starting with '.')
 * - Skip entries in FILE_EXCLUSIONS
 * - Sort directories first, then files, each alphabetically case-insensitive
 * - Children are empty arrays for directories (lazy loading)
 */
async function readDir(dirPath: string): Promise<FileTreeNode[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(dirPath)
  } catch {
    return []
  }

  const dirs: FileTreeNode[] = []
  const files: FileTreeNode[] = []

  for (const entry of entries) {
    // Skip exclusions
    if (exclusionSet.has(entry)) continue

    const fullPath = path.join(dirPath, entry)
    let stat
    try {
      stat = await fs.lstat(fullPath)
    } catch {
      // Skip files we can't stat (permission errors, etc.)
      continue
    }

    // Skip symlinks — they may point outside the workspace root.
    if (stat.isSymbolicLink()) continue

    const isDirectory = stat.isDirectory()
    const ext = isDirectory ? '' : path.extname(entry).replace(/^\./, '')

    const node: FileTreeNode = {
      name: entry,
      path: fullPath,
      isDirectory,
      isExpanded: false,
      children: [],
      fileExtension: ext,
    }

    if (isDirectory) {
      dirs.push(node)
    } else {
      files.push(node)
    }
  }

  // Sort: directories first, each group alphabetically (case-insensitive)
  const caseInsensitiveSort = (a: FileTreeNode, b: FileTreeNode): number =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })

  dirs.sort(caseInsensitiveSort)
  files.sort(caseInsensitiveSort)

  return [...dirs, ...files]
}

// ---------------------------------------------------------------------------
// File search — name + content matching with a flat result list.
// ---------------------------------------------------------------------------

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'icns', 'tiff', 'avif',
  'pdf', 'zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war',
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'wav', 'flac', 'ogg', 'm4a',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'so', 'dylib', 'dll', 'exe', 'bin', 'o', 'a', 'class', 'wasm',
  'sqlite', 'db', 'lock', 'pack', 'idx',
])

async function searchFiles(
  rootPath: string,
  query: string,
  opts: FileSearchOptions = {},
): Promise<FileSearchResult[]> {
  const maxResults = opts.maxResults ?? 200
  const maxFileBytes = opts.maxFileBytes ?? 1024 * 1024
  const lowerQuery = query.toLowerCase()
  const allowDotFiles = query.startsWith('.')
  const results: FileSearchResult[] = []
  const seenPaths = new Set<string>()

  const pushResult = (r: FileSearchResult): boolean => {
    if (seenPaths.has(r.path)) return results.length < maxResults
    seenPaths.add(r.path)
    results.push(r)
    return results.length < maxResults
  }

  const walk = async (dir: string): Promise<boolean> => {
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      return true
    }

    // Match names first (cheap), then recurse, then content-search files.
    const subdirs: string[] = []
    const files: { full: string; name: string; ext: string; size: number }[] = []

    for (const entry of entries) {
      if (exclusionSet.has(entry)) continue
      if (!allowDotFiles && entry.startsWith('.')) continue
      const full = path.join(dir, entry)
      let stat
      try {
        stat = await fs.lstat(full)
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) continue

      const isDirectory = stat.isDirectory()
      const nameMatches = entry.toLowerCase().includes(lowerQuery)
      if (nameMatches) {
        const relativePath = path.relative(rootPath, full).split(path.sep).join('/')
        if (!pushResult({ name: entry, path: full, relativePath, isDirectory, nameMatch: true })) return false
      }

      if (isDirectory) {
        subdirs.push(full)
      } else {
        const ext = path.extname(entry).replace(/^\./, '').toLowerCase()
        files.push({ full, name: entry, ext, size: stat.size })
      }
    }

    // Content-search files at this level (skip ones already added by name).
    for (const f of files) {
      if (results.length >= maxResults) return false
      if (seenPaths.has(f.full)) continue
      if (f.size === 0 || f.size > maxFileBytes) continue
      if (BINARY_EXTENSIONS.has(f.ext)) continue
      let buf: Buffer
      try {
        buf = await fs.readFile(f.full)
      } catch {
        continue
      }
      // Quick binary sniff: NUL byte in first 8KB → skip.
      const sniffEnd = Math.min(buf.length, 8192)
      let isBinary = false
      for (let i = 0; i < sniffEnd; i++) {
        if (buf[i] === 0) { isBinary = true; break }
      }
      if (isBinary) continue

      const text = buf.toString('utf-8')
      const idx = text.toLowerCase().indexOf(lowerQuery)
      if (idx === -1) continue

      // Locate the line containing the match.
      const before = text.slice(0, idx)
      const lineStart = before.lastIndexOf('\n') + 1
      const lineEndRel = text.indexOf('\n', idx)
      const lineEnd = lineEndRel === -1 ? text.length : lineEndRel
      const line = text.slice(lineStart, lineEnd).trim().slice(0, 200)
      const lineNumber = (text.slice(0, lineStart).match(/\n/g)?.length ?? 0) + 1
      const relativePath = path.relative(rootPath, f.full).split(path.sep).join('/')
      if (!pushResult({
        name: f.name, path: f.full, relativePath,
        isDirectory: false, nameMatch: false,
        contentPreview: line, contentLine: lineNumber,
      })) return false
    }

    for (const sub of subdirs) {
      if (results.length >= maxResults) return false
      const cont = await walk(sub)
      if (!cont) return false
    }
    return true
  }

  await walk(rootPath)
  // Sort: name matches first, then by relative path length (shallower first).
  results.sort((a, b) => {
    if (a.nameMatch !== b.nameMatch) return a.nameMatch ? -1 : 1
    return a.relativePath.length - b.relativePath.length
  })
  return results
}

function watchStart(dirPath: string, ownerWindowId: number): void {
  const key = watcherKey(ownerWindowId, dirPath)

  // Remove any existing subscription for this window+path first
  watchStop(dirPath, ownerWindowId)

  let shared = sharedWatchers.get(dirPath)

  if (!shared) {
    // First subscriber — create the underlying chokidar watcher
    const watcher = watch(dirPath, {
      ignoreInitial: true,
      depth: 1,
      ignored: [
        /(^|[/\\])\../, // hidden files
        ...FILE_EXCLUSIONS.map((name) => `**/${name}/**`),
      ],
    })

    shared = {
      watcher,
      refCount: 0,
      subscribers: new Map(),
    }
    sharedWatchers.set(dirPath, shared)

    // Fan out each raw watcher event only to subscribers whose `prefix` is an
    // ancestor of the changed path. This avoids waking IPC consumers (and any
    // in-process listeners such as the git monitor) for changes in unrelated
    // subtrees that happen to share the same watcher root.
    const fanOut = (type: string, fp: string) => {
      for (const sub of shared!.subscribers.values()) {
        if (pathHasPrefix(fp, sub.prefix)) sub.dispatch(type, fp)
      }
    }
    watcher.on('add', (fp: string) => fanOut('create', fp))
    watcher.on('change', (fp: string) => fanOut('update', fp))
    watcher.on('unlink', (fp: string) => fanOut('delete', fp))

    // Attach any previously-registered in-process subscribers whose prefix
    // falls under this newly-created watcher root.
    for (const sub of inProcSubs.values()) {
      if (pathHasPrefix(sub.prefix, dirPath)) {
        attachInProcToWatcher(sub, dirPath, shared)
      }
    }
  }

  // Per-requester trailing-edge debounce — coalesces a burst (e.g. git status
  // or a multi-file save) into a single IPC dispatch ~16ms after the last
  // event, keeping the renderer-visible payload shape unchanged.
  let pendingEvents = new Map<string, { type: string; path: string }>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const queueEvent = (type: string, filePath: string) => {
    pendingEvents.set(filePath, { type, path: filePath })
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        const events = pendingEvents
        pendingEvents = new Map()
        flushTimer = null
        try {
          for (const event of events.values()) {
            sendToWindow(ownerWindowId, FS_WATCH_EVENT, event)
          }
        } catch (err) {
          log.warn('[fs-watch] flush failed:', err)
        }
      }, DISPATCH_DEBOUNCE_MS)
    }
  }

  const cancelFlush = () => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    pendingEvents = new Map()
  }

  shared.subscribers.set(key, {
    prefix: dirPath,
    dispatch: queueEvent,
    cancelFlush,
  })
  shared.refCount++
  watcherKeys.set(key, dirPath)
}

function watchStop(dirPath: string, ownerWindowId: number): void {
  const key = watcherKey(ownerWindowId, dirPath)
  const normPath = watcherKeys.get(key)
  if (!normPath) return

  const shared = sharedWatchers.get(normPath)
  if (shared) {
    const sub = shared.subscribers.get(key)
    if (sub) {
      sub.cancelFlush()
      shared.subscribers.delete(key)
      shared.refCount--
    }
    if (shared.refCount <= 0) {
      shared.watcher.close()
      sharedWatchers.delete(normPath)
    }
  }
  watcherKeys.delete(key)
}

// ---------------------------------------------------------------------------
// In-process fs change subscriptions
//
// Lets other main-process modules (e.g. the git monitor) react to filesystem
// events without round-tripping through IPC. Subscribers register a path
// prefix; we deliver any change underneath it via whichever shared watcher
// roots happen to cover it. Subscribers that register before a covering
// watcher exists simply receive nothing until one does, which matches the
// existing renderer-side semantics.
// ---------------------------------------------------------------------------

type InProcListener = (filePath: string) => void

interface InProcSub {
  prefix: string
  listener: InProcListener
  // Reverse-lookup of (watcherRoot, key) we've attached to so we can detach
  // on unsubscribe without scanning.
  attachments: Array<{ root: string; key: string }>
}

let inProcSeq = 0
const inProcSubs: Map<number, InProcSub> = new Map()

function attachInProcToWatcher(sub: InProcSub, root: string, shared: SharedWatcher): void {
  const key = `inproc:${inProcSeq}-${root}`
  shared.subscribers.set(key, {
    prefix: sub.prefix,
    // No coalescing here — in-process consumers are expected to debounce
    // themselves if they care; passing every event through makes "immediate
    // poll on change" behaviour easy to reason about.
    dispatch: (_type, filePath) => sub.listener(filePath),
    cancelFlush: () => { /* no-op */ },
  })
  shared.refCount++
  sub.attachments.push({ root, key })
}

/**
 * Subscribe to filesystem change events under `prefix`. The listener fires
 * once per chokidar event whose path is `prefix` itself or lives beneath it,
 * provided some existing watcher root covers `prefix`. Returns an unsubscribe
 * fn. Safe to call even if no covering watcher exists yet — the subscription
 * is registered and will simply produce no events until one does.
 */
export function subscribeFsChanges(prefix: string, listener: InProcListener): () => void {
  const id = ++inProcSeq
  const sub: InProcSub = { prefix, listener, attachments: [] }
  inProcSubs.set(id, sub)

  for (const [root, shared] of sharedWatchers) {
    if (pathHasPrefix(prefix, root)) {
      attachInProcToWatcher(sub, root, shared)
    }
  }

  return () => {
    const s = inProcSubs.get(id)
    if (!s) return
    inProcSubs.delete(id)
    for (const { root, key } of s.attachments) {
      const shared = sharedWatchers.get(root)
      if (!shared) continue
      if (shared.subscribers.delete(key)) {
        shared.refCount--
        if (shared.refCount <= 0) {
          shared.watcher.close()
          sharedWatchers.delete(root)
        }
      }
    }
  }
}

/**
 * Stop all watchers owned by a specific window (called on window close).
 */
export function stopWatchersForWindow(windowId: number): void {
  // Collect keys first to avoid mutating the map while iterating
  const toStop: Array<[string, number]> = []
  const prefix = `${windowId}:`
  for (const [key, normPath] of watcherKeys) {
    if (key.startsWith(prefix)) toStop.push([normPath, windowId])
  }
  for (const [normPath, wid] of toStop) {
    watchStop(normPath, wid)
  }
}

/**
 * Find a non-colliding entry name for `baseName` inside `destDir`. When the item
 * is landing in the directory it already lives in (`intoSameDir`), the first
 * candidate gets a " copy" suffix so it doesn't clobber the original; otherwise
 * the original name is kept. Further collisions add an incrementing counter.
 */
async function nextAvailableName(
  destDir: string,
  baseName: string,
  intoSameDir: boolean,
): Promise<string> {
  const ext = path.extname(baseName)
  const stem = ext ? baseName.slice(0, -ext.length) : baseName
  let candidate = intoSameDir ? `${stem} copy${ext}` : baseName
  let n = 2
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await fs.lstat(path.join(destDir, candidate))
    } catch {
      // ENOENT — safe to use
      return candidate
    }
    candidate = intoSameDir ? `${stem} copy ${n}${ext}` : `${stem} (${n})${ext}`
    n++
  }
}

export function registerHandlers(): void {
  ipcMain.handle(FS_READ_FILE, async (event, filePath: string) => {
    try {
      const win = windowFromEvent(event)
      return await readFile(await validatePathStrict(filePath, win?.id))
    } catch (error) {
      log.error(`[${FS_READ_FILE}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_READ_BINARY, async (event, filePath: string) => {
    try {
      const win = windowFromEvent(event)
      const safePath = await validatePathStrict(filePath, win?.id)
      return await fs.readFile(safePath)
    } catch (error) {
      log.error(`[${FS_READ_BINARY}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_WRITE_FILE, async (event, filePath: string, content: string) => {
    try {
      const win = windowFromEvent(event)
      const safePath = await validatePathForCreation(filePath, win?.id)
      await writeFile(safePath, content)
      if (win) consumeScopedWriteAllowance(win.id, safePath)
    } catch (error) {
      log.error(`[${FS_WRITE_FILE}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_READ_DIR, async (_event, dirPath: string) => {
    try {
      return await readDir(await validatePathStrict(dirPath))
    } catch (error) {
      log.error(`[${FS_READ_DIR}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_WATCH_START, async (event, dirPath: string) => {
    try {
      const validPath = await validatePathStrict(dirPath)
      const win = windowFromEvent(event)
      if (win) {
        watchStart(validPath, win.id)
      }
    } catch (error) {
      log.error(`[${FS_WATCH_START}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_WATCH_STOP, async (event, dirPath: string) => {
    try {
      const validPath = await validatePathStrict(dirPath)
      const win = windowFromEvent(event)
      if (win) {
        watchStop(validPath, win.id)
      }
    } catch (error) {
      log.error(`[${FS_WATCH_STOP}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_STAT, async (_event, filePath: string) => {
    try {
      // Use lstat so symlinks are detected; validatePathStrict already resolves
      // the real path, but we stat the original so the caller gets correct info.
      const validPath = await validatePathStrict(filePath)
      const stat = await fs.lstat(validPath)
      if (stat.isSymbolicLink()) {
        throw new Error(`Access denied: "${filePath}" is a symbolic link`)
      }
      return { isDirectory: stat.isDirectory(), isFile: stat.isFile() }
    } catch (error) {
      log.error(`[${FS_STAT}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_DELETE, async (_event, filePath: string) => {
    try {
      const validPath = await validatePathStrict(filePath)
      // Use lstat so we never follow a symlink to determine type; delete the
      // symlink itself if one somehow passed validation.
      const stat = await fs.lstat(validPath)
      if (stat.isSymbolicLink()) {
        await fs.unlink(validPath)
      } else if (stat.isDirectory()) {
        await fs.rm(validPath, { recursive: true })
      } else {
        await fs.unlink(validPath)
      }
    } catch (error) {
      log.error(`[${FS_DELETE}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_RENAME, async (_event, oldPath: string, newPath: string) => {
    try {
      await fs.rename(await validatePathStrict(oldPath), await validatePathForCreation(newPath))
    } catch (error) {
      log.error(`[${FS_RENAME}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_COPY, async (_event, srcPath: string, destDir: string) => {
    try {
      const safeSrc = await validatePathStrict(srcPath)
      const safeDestDir = await validatePathStrict(destDir)

      const intoSameDir = path.dirname(safeSrc) === safeDestDir
      const candidate = await nextAvailableName(safeDestDir, path.basename(safeSrc), intoSameDir)
      const finalDest = await validatePathForCreation(path.join(safeDestDir, candidate))

      // Refuse to copy a directory into itself or one of its descendants.
      if (finalDest === safeSrc || finalDest.startsWith(safeSrc + path.sep)) {
        throw new Error('Cannot copy a folder into itself')
      }

      await fs.cp(safeSrc, finalDest, { recursive: true, errorOnExist: true, force: false })
      return finalDest
    } catch (error) {
      log.error(`[${FS_COPY}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  // Import external files/folders (dragged in from the OS file manager) into a
  // workspace directory. The security boundary is the DESTINATION: `destDir`
  // must resolve inside an allowed workspace root. The SOURCE paths originate
  // from a user-initiated OS drag (webUtils.getPathForFile) and may live
  // anywhere — they are only read server-side to copy/move into `destDir`, and
  // their contents are never returned to the renderer. This mirrors the
  // explicit per-window grant model used by the native Open/Save dialogs.
  ipcMain.handle(
    FS_IMPORT_ENTRIES,
    async (event, sources: string[], destDir: string, mode: 'copy' | 'move') => {
      const win = windowFromEvent(event)
      const safeDestDir = await validatePathStrict(destDir, win?.id)
      const created: string[] = []
      let failed = 0

      for (const src of Array.isArray(sources) ? sources : []) {
        try {
          // Resolve the real source (also proves it exists). Deliberately not
          // restricted to allowed roots — this is an explicit user drag.
          const realSrc = await fs.realpath(src)

          // Never import a folder into itself or one of its own descendants.
          if (safeDestDir === realSrc || safeDestDir.startsWith(realSrc + path.sep)) {
            throw new Error('Cannot import a folder into itself')
          }

          const intoSameDir = path.dirname(realSrc) === safeDestDir
          const candidate = await nextAvailableName(safeDestDir, path.basename(realSrc), intoSameDir)
          const finalDest = await validatePathForCreation(path.join(safeDestDir, candidate), win?.id)

          if (mode === 'move') {
            try {
              await fs.rename(realSrc, finalDest)
            } catch (err) {
              // rename can't cross filesystems/volumes — fall back to copy+delete.
              if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
                await fs.cp(realSrc, finalDest, { recursive: true, errorOnExist: true, force: false })
                await fs.rm(realSrc, { recursive: true, force: true })
              } else {
                throw err
              }
            }
          } else {
            await fs.cp(realSrc, finalDest, { recursive: true, errorOnExist: true, force: false })
          }
          created.push(finalDest)
        } catch (error) {
          failed++
          log.error(`[${FS_IMPORT_ENTRIES}]`, src, error)
        }
      }

      return { created, failed }
    },
  )

  ipcMain.handle(FS_MKDIR, async (_event, dirPath: string) => {
    try {
      await fs.mkdir(await validatePathForCreation(dirPath), { recursive: true })
    } catch (error) {
      log.error(`[${FS_MKDIR}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_SEARCH, async (_event, rootPath: string, query: string, options?: FileSearchOptions) => {
    try {
      const validRoot = await validatePathStrict(rootPath)
      const trimmed = (query ?? '').trim()
      if (!trimmed) return []
      return await searchFiles(validRoot, trimmed, options ?? {})
    } catch (error) {
      log.error(`[${FS_SEARCH}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })
}
