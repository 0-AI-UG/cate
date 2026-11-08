// Native guest lifetime checks. Protection survives navigation and gaps between
// automation calls; editable pages are never discarded after an input event.
import type { WebContents } from 'electron'

export function createPageLifecycle(deps: { busy(id: number): boolean }) {
  const automated = new WeakSet<WebContents>()
  const dirty = new WeakSet<WebContents>()
  const watched = new WeakSet<WebContents>()
  const watch = (page: WebContents) => {
    if (watched.has(page)) return
    watched.add(page)
    page.on('did-start-navigation', (_event, _url, inPage, mainFrame) => {
      if (mainFrame && !inPage) dirty.delete(page)
    })
  }
  return {
    watch,
    noteInput(page: WebContents) { watch(page); dirty.add(page) },
    protect(page: WebContents) {
      automated.add(page)
      page.setBackgroundThrottling(false)
    },
    async prepareDiscard(page: WebContents): Promise<boolean> {
      const blocked = () => page.isDestroyed() || automated.has(page) || dirty.has(page) || page.isLoading() || page.isCurrentlyAudible() || deps.busy(page.id)
      if (blocked()) return false
      // Check every frame, including silent video and programmatically changed
      // form fields. An unresponsive or inaccessible frame fails closed.
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const safe = await Promise.race([
          Promise.all(page.mainFrame.framesInSubtree.map(frame => frame.executeJavaScript(`(() => {
            if ([...document.querySelectorAll('audio,video')].some(e => !e.paused && !e.ended)) return false;
            if (document.querySelector('[contenteditable]:not([contenteditable="false"])')) return false;
            return [...document.querySelectorAll('input,textarea,select')].every(e => {
              if (e.tagName === 'SELECT') return [...e.options].every(o => o.selected === o.defaultSelected);
              return e.value === e.defaultValue && (!('checked' in e) || e.checked === e.defaultChecked);
            });
          })()`))).then(values => values.every(Boolean)),
          new Promise<boolean>(resolve => { timer = setTimeout(() => { dirty.add(page); resolve(false) }, 500) }),
        ])
        if (!safe || blocked()) return false
        // A webview cannot restore Chromium history after its initial load.
        // Keep multi-entry pages alive rather than losing back/forward state.
        return page.navigationHistory.getAllEntries().length <= 1
      } catch { return false } finally { clearTimeout(timer) }
    },
  }
}
