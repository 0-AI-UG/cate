// The renderer half of the page bridge, for the desktop shell's main preload
// to expose (`contextBridge.exposeInMainWorld`). Channel names are literal in
// the contract module, which is pure and small, so the preload stays one
// self-contained bundle.

import { ipcRenderer, type IpcRendererEvent } from 'electron'
import { BROWSER_PAGE_CHANNELS as C, type BrowserPageBridge } from '../../contract/pageBridge'

function listen<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, value: T) => listener(value)
  ipcRenderer.on(channel, wrapped)
  return () => { ipcRenderer.removeListener(channel, wrapped) }
}

export function createBrowserPageBridge(): BrowserPageBridge {
  return {
    attach: (guest) => ipcRenderer.invoke(C.attach, guest),
    execute: (guest, method, args) => ipcRenderer.invoke(C.execute, guest, method, args),
    restartIfHung: (guest) => ipcRenderer.invoke(C.restartIfHung, guest),
    download: (guest, url) => ipcRenderer.invoke(C.download, guest, url),
    downloadAction: (webContentsId, downloadId, action) => ipcRenderer.invoke(C.downloadAction, webContentsId, downloadId, action),
    readDownload: (webContentsId, downloadId) => ipcRenderer.invoke(C.readDownload, webContentsId, downloadId),
    fillCredential: (webContentsId, targetId, credential) => ipcRenderer.invoke(C.fillCredential, webContentsId, targetId, credential),
    stageUpload: (name, bytes) => ipcRenderer.invoke(C.stageUpload, name, bytes),
    answerDialog: (webContentsId, dialogId, answer) => ipcRenderer.invoke(C.answerDialog, webContentsId, dialogId, answer),
    onDialog: (listener) => listen(C.dialog, listener),
    screenshot: (webContentsId) => ipcRenderer.invoke(C.screenshot, webContentsId),
    onDownloads: (listener) => listen(C.downloads, listener),
    onOpenTab: (listener) => listen(C.openTab, listener),
    onShortcut: (listener) => listen(C.shortcut, listener),
    chromeProfiles: () => ipcRenderer.invoke(C.chromeProfiles),
    readChromePasswords: (profileId) => ipcRenderer.invoke(C.readChromePasswords, profileId),
    readChromePasswordCsv: () => ipcRenderer.invoke(C.readChromePasswordCsv),
  }
}
