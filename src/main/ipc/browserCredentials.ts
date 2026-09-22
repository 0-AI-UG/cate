import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { IpcMainEvent, OpenDialogOptions } from 'electron'
import {
  BROWSER_CREDENTIAL_CLEAR,
  BROWSER_CREDENTIAL_FILL,
  BROWSER_CREDENTIAL_IMPORT,
  BROWSER_CREDENTIAL_IMPORT_FILE,
  BROWSER_CREDENTIAL_SAVE,
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
  getCredentialSaveDisposition,
  getCredentialSuggestions,
  importChromePasswordCsv,
  importChromePasswords,
  removeBrowserCredential,
  saveBrowserCredential,
} from '../browser/browserCredentials'
import type { BrowserCredentialSaveInput } from '../../shared/types'
import { browserRuntime } from '../browser/browserRuntime'
import { wrapHandler } from './handlerError'
import { resolveBrowserGuest } from './browserControl'

const BROWSER_PASSWORD_SUBMIT = 'cate-browser-password-submit'
const savePrompts = new Set<number>()

interface PasswordSubmitRequest extends BrowserCredentialSaveInput {
  automated?: unknown
}

async function offerToSaveCredential(event: IpcMainEvent, request: PasswordSubmitRequest): Promise<void> {
  const contents = event.sender
  if (contents.getType() !== 'webview' || !browserRuntime.isRegistered(contents.id)) return
  const owner = BrowserWindow.fromWebContents(contents)
  if (!owner || owner.isDestroyed() || savePrompts.has(contents.id)) return

  const input: BrowserCredentialSaveInput = {
    origin: typeof request.origin === 'string' ? request.origin : '',
    username: typeof request.username === 'string' ? request.username : '',
    password: typeof request.password === 'string' ? request.password : '',
    usernameElement: typeof request.usernameElement === 'string' ? request.usernameElement : '',
    passwordElement: typeof request.passwordElement === 'string' ? request.passwordElement : '',
  }
  savePrompts.add(contents.id)
  try {
    const action = await getCredentialSaveDisposition(input)
    if (action === 'unchanged' || owner.isDestroyed()) return
    const origin = new URL(input.origin)
    const { response } = await dialog.showMessageBox(owner, {
      type: 'question',
      title: action === 'update' ? 'Update password' : 'Save password',
      message: action === 'update'
        ? `Update the saved password for ${origin.hostname}?`
        : `Save the password for ${origin.hostname}?`,
      detail: `${input.username || 'No username'}${request.automated === true ? '\n\nEntered by an agent in Cate.' : ''}`,
      buttons: [action === 'update' ? 'Update' : 'Save', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (response === 0) await saveBrowserCredential(input)
  } finally {
    savePrompts.delete(contents.id)
  }
}

export function registerBrowserCredentialHandlers(): void {
  ipcMain.on(BROWSER_PASSWORD_SUBMIT, (event, request: PasswordSubmitRequest) => {
    void offerToSaveCredential(event, request).catch(() => undefined)
  })
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
    BROWSER_CREDENTIAL_SAVE,
    wrapHandler(`[${BROWSER_CREDENTIAL_SAVE}]`, (_event, input: BrowserCredentialSaveInput) =>
      saveBrowserCredential(input)),
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
      return browserRuntime.fillCredential(contents.id, request.targetId, credential)
    }),
  )
}
