// Files and folders dragged in from the OS, read with the web File APIs so any
// client with the `fileDrop` feature can upload them through `importEntries`.
// Entries must be taken from the DataTransfer inside the drop handler; their
// contents can be read afterwards.

import type { ImportSource } from '../client'

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
