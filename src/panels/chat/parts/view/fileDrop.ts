// Files dragged in from the OS go to the chat composer: the view overlays the
// page while a file drag is in progress (the guest would swallow the drop).

import { useEffect, useState } from 'react'
import type { GuestDropFile } from '@services/t3/client'

const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files')

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
