const ordinaryPageBridge = createBrowserPageBridge()
const isolatedInvoke = (method, args) => electron.ipcRenderer.invoke('isolation:invoke', method, args)
electron.contextBridge.exposeInMainWorld('cateIsolatedFixture', {
  invoke: isolatedInvoke,
  place: (slot, box) => electron.ipcRenderer.send('isolation:placement', slot, box),
  onState(listener) {
    const receive = (_event, value) => listener(value)
    electron.ipcRenderer.on('isolation:state', receive)
    return () => electron.ipcRenderer.removeListener('isolation:state', receive)
  },
})
electron.contextBridge.exposeInMainWorld('cateBrowserPage', {
  ...ordinaryPageBridge,
  attach: guest => guest.webContentsId < 0 ? isolatedInvoke('attach', { slot: -guest.webContentsId, args: guest }) : ordinaryPageBridge.attach(guest),
  execute: (guest, method, args) => guest.webContentsId < 0
    ? isolatedInvoke('execute', { slot: -guest.webContentsId, args: { ref: guest, method, args } })
    : ordinaryPageBridge.execute(guest, method, args),
  restartIfHung: guest => guest.webContentsId < 0 ? isolatedInvoke('restart', { slot: -guest.webContentsId }) : ordinaryPageBridge.restartIfHung(guest),
})
