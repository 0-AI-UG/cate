// Files dragged in from the OS, and workspace files dragged as FileRefs (the
// explorer, search, screenshots), go to the chat composer: the view overlays
// the page while a file drag is in progress (the guest would swallow the
// drop). The T3 composer takes images only (it has no text-insert seam), so
// other files are ignored. OS files come in only on a client with the
// `fileDrop` feature (architecture 12.2); FileRef drags always do.

import { useEffect, useState } from 'react'
import type { GuestDropFile } from '@services/t3/client'
import { fileRefs } from '@workspace/files/client'
import { bytesToBase64, hasFileRefDrag, pathDisplayName, type FileRef } from '@workspace/files/contract'

const hasFiles = (event: DragEvent) =>
  hasFileRefDrag(event.dataTransfer) || Array.from(event.dataTransfer?.types ?? []).includes('Files')

/** True while files are dragged over this window. */
export function useFileDragActive(): boolean {
  const [active, setActive] = useState(false)
  useEffect(() => {
    let depth = 0
    const enter = (event: DragEvent) => { if (hasFiles(event)) { depth++; setActive(true) } }
    const leave = (event: DragEvent) => { if (hasFiles(event) && --depth <= 0) { depth = 0; setActive(false) } }
    const end = () => { depth = 0; setActive(false) }
    document.addEventListener('dragenter', enter)
    document.addEventListener('dragleave', leave)
    document.addEventListener('drop', end, true)
    document.addEventListener('dragend', end)
    return () => {
      document.removeEventListener('dragenter', enter)
      document.removeEventListener('dragleave', leave)
      document.removeEventListener('drop', end, true)
      document.removeEventListener('dragend', end)
    }
  }, [])
  return active
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** The dropped images as the page recreates them. */
export async function droppedImages(files: readonly File[]): Promise<GuestDropFile[]> {
  const images = files.filter((file) => file.type.startsWith('image/'))
  return Promise.all(images.map(async (file) => ({ name: file.name, type: file.type, dataUrl: await readDataUrl(file) })))
}

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** The dropped workspace images (by extension), read through their runtimes. */
export async function droppedRefImages(refs: readonly FileRef[], readBytes: (ref: FileRef) => Promise<Uint8Array> = fileRefs.readBytes): Promise<GuestDropFile[]> {
  const images = refs.flatMap((ref) => {
    const name = pathDisplayName(ref.path)
    const type = IMAGE_TYPES[name.slice(name.lastIndexOf('.') + 1).toLowerCase()]
    return type && name.includes('.') ? [{ ref, name, type }] : []
  })
  const read = await Promise.all(images.map(async ({ ref, name, type }) => {
    try {
      return { name, type, dataUrl: `data:${type};base64,${bytesToBase64(await readBytes(ref))}` }
    } catch {
      return null
    }
  }))
  return read.filter((file): file is GuestDropFile => file !== null)
}
