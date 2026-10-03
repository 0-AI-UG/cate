// Uploads: a page's file input on a client asks for a file that lives on the
// runtime's machine. The path is checked against the workspace's path scope.

import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'

export interface UploadPathScope {
  /** Canonical path when it is inside the workspace, a checkout, the data dir
   *  or a grant; throws otherwise. */
  validate(target: string): string | Promise<string>
}

/** Resolves an upload path to a readable file, hiding why a path was refused. */
export async function authorizeUpload(scope: UploadPathScope, target: unknown): Promise<{ path: string; size: number }> {
  if (typeof target !== 'string' || !target) throw new Error('browser-upload-file-required')
  let safePath: string
  try {
    safePath = await scope.validate(target)
  } catch {
    throw new Error('browser-upload-path-denied')
  }
  try {
    const stat = await fs.stat(safePath)
    if (!stat.isFile()) throw new Error('not-file')
    return { path: safePath, size: stat.size }
  } catch {
    throw new Error('browser-upload-file-required')
  }
}

export function uploadName(file: string): string {
  return path.basename(file)
}

export function openUploadStream(file: string, signal?: AbortSignal) {
  return createReadStream(file, { signal })
}
