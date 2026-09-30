// Recent OS screenshots on the canvas: a desktop shell port gated on the
// `screenCapture` client feature. The shell watches the OS screenshot folder,
// reads originals and starts native drags; annotated copies are stored in the
// workspace data through the runtime `file` capability, then handed back to
// the shell so they join the recent stack.

import { tryRuntimeFor } from '@kernel/rpc/client'
import { fsClient } from '@workspace/files/client'

export interface RecentScreenshot {
  id: string
  filePath: string
  annotated?: boolean
  /** Small thumbnail for the stack and the native drag icon. */
  dataUrl: string
}

export interface ScreenshotPort {
  /** The recent screenshots, newest first. */
  recent(): Promise<RecentScreenshot[]>
  /** Fires with the whole recent list whenever it changes. */
  onChanged(listener: (recent: RecentScreenshot[]) => void): () => void
  /** The original image as a data URL. */
  read(id: string): Promise<string>
  /** Starts a native OS drag of the screenshot file. */
  drag(id: string): Promise<void>
  /** Adds a saved annotated image (its file already written) to the stack. */
  addAnnotated(filePath: string, dataUrl: string): Promise<RecentScreenshot>
}

let port: ScreenshotPort | null = null
const listeners = new Set<() => void>()

export function installScreenshotPort(next: ScreenshotPort | null): void {
  port = next
  for (const listener of [...listeners]) listener()
}

export function screenshotPort(): ScreenshotPort | null {
  return port
}

export function subscribeScreenshotPort(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function dataUrlBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Stores an annotated PNG in the workspace data's `screenshots/` (where
 *  agents read it through the runtime) and registers it with the shell. */
export async function saveAnnotatedScreenshot(workspaceId: string, source: RecentScreenshot, dataUrl: string): Promise<RecentScreenshot> {
  if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('Expected a PNG image.')
  if (!tryRuntimeFor(workspaceId)) throw new Error('The workspace is not open.')
  const base = (source.filePath.split(/[/\\]/).pop() ?? 'screenshot').replace(/\.[^.]+$/, '')
  const { path } = await fsClient(workspaceId).storeScreenshot(`${base}-annotated.png`, dataUrlBytes(dataUrl))
  const shell = screenshotPort()
  if (!shell) return { id: globalThis.crypto.randomUUID(), filePath: path, dataUrl, annotated: true }
  return shell.addAnnotated(path, dataUrl)
}
