// =============================================================================
// Filesystem IPC handlers — file read/write and directory watching
// =============================================================================

import fs from 'fs/promises'
import path from 'path'
import { watch, FSWatcher } from 'chokidar'
import { ipcMain, BrowserWindow } from 'electron'
import {
  FS_READ_FILE,
  FS_WRITE_FILE,
  FS_READ_DIR,
  FS_WATCH_START,
  FS_WATCH_STOP,
  FS_WATCH_EVENT,
  FS_STAT,
  FS_DELETE,
} from '../../shared/ipc-channels'
import { FileTreeNode, FILE_EXCLUSIONS } from '../../shared/types'

// Active chokidar file watchers keyed by directory path
const watchers: Map<string, { watcher: FSWatcher; cancelFlush?: () => void }> = new Map()

// Set of exclusion names for fast lookup
const exclusionSet = new Set(FILE_EXCLUSIONS)

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

function watchStart(dirPath: string, mainWindow: BrowserWindow): void {
  // Stop existing watcher for this path if any
  watchStop(dirPath)

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
        if (mainWindow.isDestroyed()) return
        for (const event of pendingEvents.values()) {
          mainWindow.webContents.send(FS_WATCH_EVENT, event)
        }
        pendingEvents = new Map()
      }, 150)
    }
  }

  watcher.on('add', (filePath: string) => queueEvent('create', filePath))
  watcher.on('change', (filePath: string) => queueEvent('update', filePath))
  watcher.on('unlink', (filePath: string) => queueEvent('delete', filePath))

  watchers.set(dirPath, {
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

function watchStop(dirPath: string): void {
  const entry = watchers.get(dirPath)
  if (entry) {
    entry.cancelFlush?.()
    entry.watcher.close()
    watchers.delete(dirPath)
  }
}

export function registerHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle(FS_READ_FILE, async (_event, filePath: string) => {
    return readFile(filePath)
  })

  ipcMain.handle(FS_WRITE_FILE, async (_event, filePath: string, content: string) => {
    await writeFile(filePath, content)
  })

  ipcMain.handle(FS_READ_DIR, async (_event, dirPath: string) => {
    return readDir(dirPath)
  })

  ipcMain.handle(FS_WATCH_START, async (_event, dirPath: string) => {
    watchStart(dirPath, mainWindow)
  })

  ipcMain.handle(FS_WATCH_STOP, async (_event, dirPath: string) => {
    watchStop(dirPath)
  })

  ipcMain.handle(FS_STAT, async (_event, filePath: string) => {
    const stat = await fs.stat(filePath)
    return { isDirectory: stat.isDirectory(), isFile: stat.isFile() }
  })

  ipcMain.handle(FS_DELETE, async (_event, filePath: string) => {
    const stat = await fs.stat(filePath)
    if (stat.isDirectory()) {
      await fs.rm(filePath, { recursive: true })
    } else {
      await fs.unlink(filePath)
    }
  })
}
