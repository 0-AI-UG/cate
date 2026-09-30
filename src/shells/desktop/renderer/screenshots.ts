// The canvas screenshot port (`screenCapture`) over the desktop capture IPC:
// main watches the OS screenshot folder; annotated copies saved in this window
// join the stack here.

import type { RecentScreenshot, ScreenshotPort } from '@client/layout/canvas'
import type { DesktopApi, RecentScreenshot as ShellScreenshot } from '../contract'

/** Main's ids are `<path>:<mtime>`. */
const pathOf = (id: string) => id.slice(0, id.lastIndexOf(':')) || id

function bytesToDataUrl(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return `data:image/png;base64,${btoa(binary)}`
}

export function createScreenshotPort(api: DesktopApi): ScreenshotPort {
  let annotated: RecentScreenshot[] = []
  let shell: RecentScreenshot[] = []
  const listeners = new Set<(recent: RecentScreenshot[]) => void>()
  const recent = () => [...annotated, ...shell]
  const emit = () => { for (const listener of [...listeners]) listener(recent()) }
  const fromShell = (shots: ShellScreenshot[]) => {
    shell = shots.map((shot) => ({ id: shot.id, filePath: pathOf(shot.id), dataUrl: shot.thumbnail }))
  }
  api.capture.onRecentScreenshots((shots) => {
    fromShell(shots)
    emit()
  })

  return {
    async recent() {
      fromShell(await api.capture.recentScreenshots())
      return recent()
    },
    onChanged(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async read(id) {
      const own = annotated.find((shot) => shot.id === id)
      if (own) return own.dataUrl
      return bytesToDataUrl(await api.capture.readRecentScreenshot(id))
    },
    async drag(id) {
      // Annotated copies live in the workspace, not in main's watched folder.
      if (annotated.some((shot) => shot.id === id)) return
      await api.capture.dragRecentScreenshot(id)
    },
    async addAnnotated(filePath, dataUrl) {
      const shot: RecentScreenshot = { id: `annotated:${globalThis.crypto.randomUUID()}`, filePath, dataUrl, annotated: true }
      annotated = [shot, ...annotated].slice(0, 10)
      emit()
      return shot
    },
  }
}
