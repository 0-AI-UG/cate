import fs from 'node:fs/promises'
import { validatePathStrict } from '../ipc/pathValidation'

/** Authorize a browser upload at the main-process filesystem boundary. */
export async function authorizeBrowserUploadCommand(
  command: readonly string[],
  ownerWindowId: number,
  workspaceId: string,
): Promise<string[]> {
  if (command[0] !== 'upload') return [...command]
  if (command.length !== 3) throw new Error('upload-requires-target-and-file')

  let safePath: string
  try {
    safePath = await validatePathStrict(command[2], ownerWindowId, workspaceId)
  } catch {
    throw new Error('browser-upload-path-denied')
  }

  try {
    if (!(await fs.stat(safePath)).isFile()) throw new Error('not-file')
  } catch {
    throw new Error('browser-upload-file-required')
  }
  return [command[0], command[1], safePath]
}
