// Recent OS screenshots on the canvas: a desktop shell port gated on the
// `screenCapture` client feature. The shell watches the OS screenshot folder,
// reads originals and starts native drags of those device files; annotated
// copies are stored in the workspace data through the runtime `file`
// capability, then handed back to the shell as FileRefs so they join the
// recent stack and drag like any workspace file.

import { tryRuntimeFor } from '@kernel/rpc/client'
import { fsClient } from '@workspace/files/client'
import { base64ToBytes, type FileRef } from '@workspace/files/contract'

export interface RecentScreenshot {
  id: string
  /** The file's path: on this device for an OS capture, in `ref`'s
   *  workspace for a stored (annotated) one. Names the file. */
  filePath: string
  /** A screenshot stored in a workspace: dragged as a FileRef. */
  ref?: FileRef
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
  /** Starts a native OS drag of a device screenshot file (not one with a `ref`). */
  drag(id: string): Promise<void>
  /** Adds a saved annotated image (stored in a workspace) to the stack. */
  addAnnotated(ref: FileRef, dataUrl: string): Promise<RecentScreenshot>
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

/** Stores an annotated PNG in the workspace data's `screenshots/` (where
 *  agents read it through the runtime) and registers it with the shell. */
export async function saveAnnotatedScreenshot(workspaceId: string, source: RecentScreenshot, dataUrl: string): Promise<RecentScreenshot> {
  if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('Expected a PNG image.')
  if (!tryRuntimeFor(workspaceId)) throw new Error('The workspace is not open.')
  const base = (source.filePath.split(/[/\\]/).pop() ?? 'screenshot').replace(/\.[^.]+$/, '')
  const { path } = await fsClient(workspaceId).storeScreenshot(`${base}-annotated.png`, base64ToBytes(dataUrl.slice(dataUrl.indexOf(',') + 1)))
  const ref: FileRef = { workspaceId, path }
  const shell = screenshotPort()
  if (!shell) return { id: globalThis.crypto.randomUUID(), filePath: path, ref, dataUrl, annotated: true }
  return shell.addAnnotated(ref, dataUrl)
}
