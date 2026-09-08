import fs from 'node:fs/promises'
import { validatePathStrict } from '../ipc/pathValidation'

/** Authorize a browser upload at the main-process filesystem boundary. */
export async function authorizeBrowserUpload(
  filePath: unknown,
  ownerWindowId: number,
  workspaceId: string,
): Promise<string> {
  if (typeof filePath !== 'string' || !filePath) throw new Error('browser-upload-file-required')

  let safePath: string
  try {
    safePath = await validatePathStrict(filePath, ownerWindowId, workspaceId)
  } catch {
    throw new Error('browser-upload-path-denied')
  }

  try {
    if (!(await fs.stat(safePath)).isFile()) throw new Error('not-file')
  } catch {
    throw new Error('browser-upload-file-required')
  }
  return safePath
}
