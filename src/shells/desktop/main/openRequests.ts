// Paths and URLs opened with the app (Finder "Open With", the dock, a web
// link handed to Cate). A path is added and opened as a local workspace, a URL
// opens in a browser panel: both by the main window's renderer, once it said
// it listens. Requests before that are queued. Register before app ready:
// macOS sends `open-file` early.

import type { WebContents } from 'electron'

interface OpenRequestTarget {
  contents: WebContents
  focus(): void
}

export interface OpenRequestsDeps {
  /** The main window to deliver to, if any. */
  target(): OpenRequestTarget | undefined
  /** Open a main window when a URL arrives with none (after startup). */
  createMainWindow(): void
  started(): boolean
  channels: { path: string; url: string }
  focusOnDeliver: boolean
}

function isWebUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function createOpenRequests(deps: OpenRequestsDeps) {
  const pending: { kind: 'path' | 'url'; value: string }[] = []
  const ready = new WeakSet<WebContents>()

  const flush = () => {
    const target = deps.target()
    if (!target || !ready.has(target.contents) || target.contents.isDestroyed() || pending.length === 0) return
    if (deps.focusOnDeliver) target.focus()
    for (const request of pending.splice(0)) {
      target.contents.send(request.kind === 'path' ? deps.channels.path : deps.channels.url, request.value)
    }
  }

  return {
    openPath(path: string) {
      pending.push({ kind: 'path', value: path })
      flush()
    },
    openUrl(url: string) {
      if (!isWebUrl(url)) return
      pending.push({ kind: 'url', value: url })
      if (!deps.target() && deps.started()) deps.createMainWindow()
      flush()
    },
    /** The renderer listens (again, after a reload). */
    markReady(contents: WebContents) {
      if (!ready.has(contents)) {
        ready.add(contents)
        contents.on('did-start-navigation', (details) => {
          if (details.isMainFrame && !details.isSameDocument) ready.delete(contents)
        })
      }
      flush()
    },
    flush,
  }
}

export type OpenRequests = ReturnType<typeof createOpenRequests>
