// The canvas screenshot port (`screenCapture`) over the desktop capture IPC:
// main keeps the one recent list, OS captures from the screenshot folder and
// annotated copies stored in a workspace, and sends it to every window.
// Annotated copies are read through their workspace's runtime.

import type { RecentScreenshot, ScreenshotPort } from '@client/layout/canvas'
import { fileRefs } from '@workspace/files/client'
import { base64ToBytes } from '@workspace/files/contract'
import type { DesktopApi, RecentScreenshot as ShellScreenshot } from '../contract'

/** Main's ids for OS captures are `<path>:<mtime>`. */
const pathOf = (id: string) => id.slice(0, id.lastIndexOf(':')) || id

function bytesToDataUrl(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:image/png;base64,${btoa(binary)}`
}

const fromShell = (shot: ShellScreenshot): RecentScreenshot => shot.ref
  ? { id: shot.id, filePath: shot.ref.path, ref: shot.ref, annotated: true, dataUrl: shot.thumbnail }
  : { id: shot.id, filePath: pathOf(shot.id), dataUrl: shot.thumbnail }

export function createScreenshotPort(api: DesktopApi): ScreenshotPort {
  let shots: RecentScreenshot[] = []
  const listeners = new Set<(recent: RecentScreenshot[]) => void>()
  api.capture.onRecentScreenshots((next) => {
    shots = next.map(fromShell)
    for (const listener of [...listeners]) listener(shots)
  })

  return {
    async recent() {
      shots = (await api.capture.recentScreenshots()).map(fromShell)
      return shots
    },
    onChanged(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async read(id) {
      const ref = shots.find((shot) => shot.id === id)?.ref
      return bytesToDataUrl(ref ? await fileRefs.readBytes(ref) : await api.capture.readRecentScreenshot(id))
    },
    async drag(id) {
      // Annotated copies live in a workspace and drag as FileRefs.
      if (shots.some((shot) => shot.id === id && shot.ref)) return
      await api.capture.dragRecentScreenshot(id)
    },
    async addAnnotated(ref, dataUrl) {
      return fromShell(await api.capture.addAnnotatedScreenshot(ref, base64ToBytes(dataUrl.slice(dataUrl.indexOf(',') + 1))))
    },
  }
}
