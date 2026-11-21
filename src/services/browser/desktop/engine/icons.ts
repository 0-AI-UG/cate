// Even favicons are untrusted page graphics. Rasterize them in the engine,
// so an SVG in a tab/history row never runs on Cate's own raster worker.
import { BrowserWindow, type Session } from 'electron'

export function createBrowserIcons() {
  let renderer: Promise<BrowserWindow> | undefined
  const cache = new Map<string, Promise<string | null>>()
  const render = async (url: string, session: Session): Promise<string | null> => {
    if (!/^(https?:|data:)/.test(url)) return null
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 3000)
    try {
      const response = await session.fetch(url, { signal: abort.signal })
      if (!response.ok || !response.body) return null
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        total += value.length
        if (total > 128 * 1024) { await reader.cancel(); return null }
        chunks.push(value)
      }
      const mime = (response.headers.get('content-type') ?? 'image/x-icon').split(';')[0]
      if (!/^image\/[a-z0-9.+-]+$/i.test(mime)) return null
      const source = `data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`
      renderer ??= (async () => {
        const window = new BrowserWindow({ show: false, width: 32, height: 32, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        await window.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:">')
        return window
      })()
      const window = await renderer
      return await window.webContents.executeJavaScript(`new Promise(resolve => {
        const image=new Image();const timer=setTimeout(()=>resolve(null),1500);
        image.onerror=()=>{clearTimeout(timer);resolve(null)};
        image.onload=()=>{clearTimeout(timer);const c=document.createElement('canvas');c.width=c.height=32;
          c.getContext('2d').drawImage(image,0,0,32,32);resolve(c.toDataURL('image/png'))};
        image.src=${JSON.stringify(source)};
      })`)
    } catch { return null } finally { clearTimeout(timer) }
  }
  return {
    get(partition: string, url: string, session: Session): Promise<string | null> {
      const key = `${partition}\0${url}`
      let value = cache.get(key)
      if (!value) {
        value = render(url, session); cache.set(key, value)
        if (cache.size > 128) cache.delete(cache.keys().next().value!)
      }
      return value
    },
  }
}
