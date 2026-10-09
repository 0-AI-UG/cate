// Dropped files: refs dragged from Cate's own views, and files and folders
// dragged in from the OS (read with the web File APIs, so any client with the
// `fileDrop` feature can upload them). Everything must be taken from the
// DataTransfer inside the drop handler; contents are read afterwards.

import { fileRefs, type DroppedImport, type FileRefs, type ImportSource, type RefTarget } from '@workspace/files/client'
import { hasFileRefDrag, readFileRefDrag, type FileLineLocation, type FileRef } from '@workspace/files/contract'

/** True when the drag carries OS files (an external drop), not an internal
 *  Cate panel or file drag. */
export function isExternalFileDrag(e: { dataTransfer: Pick<DataTransfer, 'types'> }): boolean {
  return Array.from(e.dataTransfer.types).includes('Files')
}

/** A dropped top-level item: a directory entry, or a plain file. */
export type DroppedItem = { entry: FileSystemEntry } | { file: File }
export type DroppedItems = DroppedItem[]

/** Takes the dropped items synchronously, in the drop handler. */
export function takeDroppedItems(dataTransfer: Pick<DataTransfer, 'items' | 'files'>): DroppedItems {
  const items = Array.from(dataTransfer.items ?? []).filter((item) => item.kind === 'file')
  const entries = items.map((item) => item.webkitGetAsEntry?.() ?? null)
  if (entries.length > 0 && entries.every((entry) => entry !== null)) {
    return entries.map((entry) => ({ entry: entry as FileSystemEntry }))
  }
  return Array.from(dataTransfer.files ?? []).map((file) => ({ file }))
}

const fileOf = (entry: FileSystemFileEntry): Promise<File> =>
  new Promise((resolve, reject) => entry.file(resolve, reject))

async function listDirectory(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = entry.createReader()
  const out: FileSystemEntry[] = []
  // readEntries returns batches until an empty one.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
    if (batch.length === 0) return out
    out.push(...batch)
  }
}

const fileSource = (path: string, file: File): ImportSource => ({
  path,
  kind: 'file',
  size: file.size,
  bytes: async () => new Uint8Array(await file.arrayBuffer()),
})

/** The upload manifest: directories before their contents. */
/** Dropped items as the file tree imports them. */
export const droppedImport = (items: DroppedItems): DroppedImport => ({ count: items.length, read: () => readDroppedEntries(items) })

export async function readDroppedEntries(items: DroppedItems): Promise<ImportSource[]> {
  const out: ImportSource[] = []
  const walk = async (entry: FileSystemEntry, path: string): Promise<void> => {
    if (entry.isDirectory) {
      out.push({ path, kind: 'dir' })
      for (const child of await listDirectory(entry as FileSystemDirectoryEntry)) await walk(child, `${path}/${child.name}`)
    } else if (entry.isFile) {
      out.push(fileSource(path, await fileOf(entry as FileSystemFileEntry)))
    }
  }
  for (const item of items) {
    if ('file' in item) out.push(fileSource(item.file.name, item.file))
    else await walk(item.entry, item.entry.name)
  }
  return out
}

/** What dropping a file-ref drag into the explorer does: a copy when
 *  Option/Alt is held or the source only allows copying (search results),
 *  else a move. Refs of another workspace are always copied. */
export function refDropMode(e: { altKey: boolean; dataTransfer: Pick<DataTransfer, 'effectAllowed'> }): 'move' | 'copy' {
  return e.altKey || e.dataTransfer.effectAllowed === 'copy' ? 'copy' : 'move'
}

// ---- any file drop, for every drop target -----------------------------------

/** A drop of files, taken inside the drop handler: refs from Cate's own
 *  views, or items from the OS. */
export interface FileDrop {
  refs: FileRef[]
  location: FileLineLocation | null
  os: DroppedItems
}

/** True when the drag carries files of either kind. */
export function isAnyFileDrag(e: { dataTransfer: Pick<DataTransfer, 'types'> | null }): boolean {
  return !!e.dataTransfer && (hasFileRefDrag(e.dataTransfer) || Array.from(e.dataTransfer.types).includes('Files'))
}

/** Takes a drop's files; null when it carries none. Synchronous: call it in
 *  the drop handler. */
export function takeFileDrop(dataTransfer: DataTransfer): FileDrop | null {
  const drag = readFileRefDrag(dataTransfer)
  if (drag) return { refs: drag.refs, location: drag.location ?? null, os: [] }
  const os = Array.from(dataTransfer.types).includes('Files') ? takeDroppedItems(dataTransfer) : []
  return os.length > 0 ? { refs: [], location: null, os } : null
}

/** The paths the target workspace uses for a drop: its own files as they
 *  are; other workspaces' and OS files copied into the target checkout's
 *  temporary folder. A dropped line follows its file. */
export async function resolveFileDrop(drop: FileDrop, target: RefTarget, refs: FileRefs = fileRefs): Promise<{ paths: string[]; location: FileLineLocation | null }> {
  if (drop.os.length > 0) return { paths: await refs.upload(await readDroppedEntries(drop.os), target), location: null }
  const paths = await refs.localize(drop.refs, target)
  const at = drop.location ? drop.refs.findIndex((ref) => ref.path === drop.location!.path) : -1
  return { paths, location: drop.location && paths[at] ? { ...drop.location, path: paths[at] } : null }
}
