// =============================================================================
// Filesystem IPC handlers — file read/write and directory watching
// =============================================================================

import fs from 'fs/promises'
import path from 'path'
import { watch, FSWatcher } from 'chokidar'
import { ipcMain } from 'electron'
import log from '../logger'
import { validatePath } from './pathValidation'
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
} from '../../shared/ipc-channels'
import { FileTreeNode, FILE_EXCLUSIONS } from '../../shared/types'
import { sendToWindow, windowFromEvent } from '../windowRegistry'

// Active chokidar file watchers keyed by "windowId:dirPath"
const watchers: Map<string, { watcher: FSWatcher; cancelFlush?: () => void }> = new Map()

// Set of exclusion names for fast lookup
const exclusionSet = new Set(FILE_EXCLUSIONS)

function watcherKey(windowId: number, dirPath: string): string {
  return `${windowId}:${dirPath}`
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
    // Skip hidden files and exclusions
    if (entry.startsWith('.')) continue
    if (exclusionSet.has(entry)) continue

    const fullPath = path.join(dirPath, entry)
    let stat
    try {
      stat = await fs.stat(fullPath)
    } catch {
      // Skip files we can't stat (permission errors, broken symlinks, etc.)
      continue
    }

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

function watchStart(dirPath: string, ownerWindowId: number): void {
  const key = watcherKey(ownerWindowId, dirPath)

  // Stop existing watcher for this window+path if any
  watchStop(dirPath, ownerWindowId)

  const watcher = watch(dirPath, {
    ignoreInitial: true,
    depth: 1,
    ignored: [
      /(^|[/\\])\../, // hidden files
      ...FILE_EXCLUSIONS.map((name) => `**/${name}/**`),
    ],
  })

  // Batch file watch events to prevent IPC storms during npm install, git checkout, etc.
  let pendingEvents = new Map<string, { type: string; path: string }>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const queueEvent = (type: string, filePath: string) => {
    pendingEvents.set(filePath, { type, path: filePath })
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null
        for (const event of pendingEvents.values()) {
          sendToWindow(ownerWindowId, FS_WATCH_EVENT, event)
        }
        pendingEvents = new Map()
      }, 150)
    }
  }

  watcher.on('add', (filePath: string) => queueEvent('create', filePath))
  watcher.on('change', (filePath: string) => queueEvent('update', filePath))
  watcher.on('unlink', (filePath: string) => queueEvent('delete', filePath))

  watchers.set(key, {
    watcher,
    cancelFlush: () => {
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      pendingEvents = new Map()
    },
  })
}

function watchStop(dirPath: string, ownerWindowId: number): void {
  const key = watcherKey(ownerWindowId, dirPath)
  const entry = watchers.get(key)
  if (entry) {
    entry.cancelFlush?.()
    entry.watcher.close()
    watchers.delete(key)
  }
}

/**
 * Stop all watchers owned by a specific window (called on window close).
 */
export function stopWatchersForWindow(windowId: number): void {
  const prefix = `${windowId}:`
  for (const [key, entry] of watchers) {
    if (key.startsWith(prefix)) {
      entry.cancelFlush?.()
      entry.watcher.close()
      watchers.delete(key)
    }
  }
}

export function registerHandlers(): void {
  ipcMain.handle(FS_READ_FILE, async (_event, filePath: string) => {
    try {
      return await readFile(validatePath(filePath))
    } catch (error) {
      log.error(`[${FS_READ_FILE}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_WRITE_FILE, async (_event, filePath: string, content: string) => {
    try {
      await writeFile(validatePath(filePath), content)
    } catch (error) {
      log.error(`[${FS_WRITE_FILE}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_READ_DIR, async (_event, dirPath: string) => {
    try {
      return await readDir(validatePath(dirPath))
    } catch (error) {
      log.error(`[${FS_READ_DIR}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_WATCH_START, async (event, dirPath: string) => {
    try {
      const validPath = validatePath(dirPath)
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
      const validPath = validatePath(dirPath)
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
      const stat = await fs.stat(validatePath(filePath))
      return { isDirectory: stat.isDirectory(), isFile: stat.isFile() }
    } catch (error) {
      log.error(`[${FS_STAT}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_DELETE, async (_event, filePath: string) => {
    try {
      const validPath = validatePath(filePath)
      const stat = await fs.stat(validPath)
      if (stat.isDirectory()) {
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
      await fs.rename(validatePath(oldPath), validatePath(newPath))
    } catch (error) {
      log.error(`[${FS_RENAME}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })

  ipcMain.handle(FS_MKDIR, async (_event, dirPath: string) => {
    try {
      await fs.mkdir(validatePath(dirPath), { recursive: true })
    } catch (error) {
      log.error(`[${FS_MKDIR}]`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  })
}
