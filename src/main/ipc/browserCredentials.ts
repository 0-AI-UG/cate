import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { OpenDialogOptions } from 'electron'
import {
  BROWSER_CREDENTIAL_CLEAR,
  BROWSER_CREDENTIAL_FILL,
  BROWSER_CREDENTIAL_IMPORT,
  BROWSER_CREDENTIAL_IMPORT_FILE,
  BROWSER_CREDENTIAL_LIST,
  BROWSER_CREDENTIAL_PROFILES,
  BROWSER_CREDENTIAL_REMOVE,
  BROWSER_CREDENTIAL_SUGGESTIONS,
} from '../../shared/ipc-channels'
import {
  clearBrowserCredentials,
  getBrowserCredentials,
  getBrowserCredentialProfiles,
  getCredentialForFill,
  getCredentialSuggestions,
  importChromePasswordCsv,
  importChromePasswords,
  removeBrowserCredential,
} from '../browser/browserCredentials'
import { agentBrowserService } from '../browser/agentBrowser'
import { wrapHandler } from './handlerError'
import { resolveBrowserGuest } from './browserControl'

export function registerBrowserCredentialHandlers(): void {
  ipcMain.handle(
    BROWSER_CREDENTIAL_PROFILES,
    wrapHandler(`[${BROWSER_CREDENTIAL_PROFILES}]`, () => getBrowserCredentialProfiles()),
  )
  ipcMain.handle(
    BROWSER_CREDENTIAL_LIST,
    wrapHandler(`[${BROWSER_CREDENTIAL_LIST}]`, () => getBrowserCredentials()),
  )
  ipcMain.handle(
    BROWSER_CREDENTIAL_IMPORT,
    wrapHandler(`[${BROWSER_CREDENTIAL_IMPORT}]`, (_event, profileId: string) =>
      importChromePasswords(profileId)),
  )
  ipcMain.handle(
    BROWSER_CREDENTIAL_IMPORT_FILE,
    wrapHandler(`[${BROWSER_CREDENTIAL_IMPORT_FILE}]`, async (event) => {
      const owner = BrowserWindow.fromWebContents(event.sender)
      const options: OpenDialogOptions = {
        title: 'Import Chrome passwords',
        properties: ['openFile'],
        filters: [{ name: 'Chrome password export', extensions: ['csv'] }],
      }
      const result = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths[0]) {
        return { canceled: true, imported: 0, skipped: 0, total: 0 }
      }
      return {
        canceled: false,
        ...await importChromePasswordCsv(result.filePaths[0]),
      }
    }),
  )
  ipcMain.handle(
    BROWSER_CREDENTIAL_REMOVE,
    wrapHandler(`[${BROWSER_CREDENTIAL_REMOVE}]`, (_event, credentialId: string) =>
      removeBrowserCredential(credentialId)),
  )
  ipcMain.handle(
    BROWSER_CREDENTIAL_CLEAR,
    wrapHandler(`[${BROWSER_CREDENTIAL_CLEAR}]`, () => clearBrowserCredentials()),
  )
  ipcMain.handle(
    BROWSER_CREDENTIAL_SUGGESTIONS,
    wrapHandler(`[${BROWSER_CREDENTIAL_SUGGESTIONS}]`, async (event, webContentsId: number) => {
      const contents = resolveBrowserGuest(event, webContentsId)
      if (!contents) return { error: 'no-guest' }
      return { suggestions: await getCredentialSuggestions(contents.getURL()) }
    }),
  )
  ipcMain.handle(
    BROWSER_CREDENTIAL_FILL,
    wrapHandler(`[${BROWSER_CREDENTIAL_FILL}]`, async (
      event,
      request: { webContentsId: number; credentialId: string; targetId: string },
    ) => {
      const contents = resolveBrowserGuest(event, request.webContentsId)
      if (!contents) return { error: 'no-guest' }
      const credential = await getCredentialForFill(request.credentialId, contents.getURL())
      if (!credential) return { error: 'credential-not-found' }
      return agentBrowserService.fillCredential(contents.id, request.targetId, credential)
    }),
  )
}
