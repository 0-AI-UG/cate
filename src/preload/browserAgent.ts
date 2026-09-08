import { contextBridge, ipcRenderer } from 'electron'

// This preload belongs only to the isolated agent-code runner, never to a page.
contextBridge.exposeInMainWorld('__cateBrowserBridge', {
  invoke: (request: string) => ipcRenderer.invoke('cate:browser-code', request),
})
