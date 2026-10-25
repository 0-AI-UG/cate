// Page operations on this client's pages (architecture 10.2): the `page.*`
// requests a browser session sends its driving client, run through the page
// bridge on a guest the panel's page host has ready. Choosing what to do is
// the runtime's (page control); this moves files a file input needs to this
// client, renders a parked page while an agent works on it, and keeps the
// person's focus where it is while an agent acts.

import { BROWSER_ACTION_METHODS, type BrowserDriverResult } from '../../contract/automation'
import type { BrowserGuestRef, BrowserPageBridge } from '../../contract/pageBridge'

/** A tab's page, ready for a page operation. */
export interface PageOpTarget {
  guest: BrowserGuestRef
  /** The document the guest's <webview> lives in. */
  document: Document
  /** A parked guest (its panel off screen) paints nothing to capture. */
  hidden: boolean
  /** Renders a parked guest, still unseen, until the returned call; without
   *  it a parked guest stays hidden and screenshots of it fail. */
  stage?(): () => void
  /** Throws once the tab is no longer the one the operation is bound to. */
  check(): void
}

export interface PageOpsDeps {
  bridge: BrowserPageBridge
  /** Moves a runtime file to this client for a file input. */
  fetchUpload?(path: string): Promise<{ name: string; bytes: Uint8Array }>
}

export interface PageOps {
  /** One page-driver method (observations, actions, waits). */
  execute(target: PageOpTarget, method: string, args: Record<string, unknown>): Promise<BrowserDriverResult>
  /** Downloads `url` through the guest's partition. */
  download(target: PageOpTarget, url: string): Promise<void>
}

/** An agent's click focuses its guest in the window, which then gets the
 *  person's keys (Chromium fires no focus event on the <webview>, only a blur
 *  on what had focus). While an action runs, focus the guest takes goes back
 *  to the element that lost it; the page keeps its own focus (the driver
 *  emulates it), so the action still works. Returns the release. */
function keepFocus(target: PageOpTarget): () => void {
  const owner = target.document
  const taken = (): boolean => {
    const active = owner.activeElement
    return active instanceof HTMLElement && active.tagName === 'WEBVIEW'
      && (active as HTMLElement & { getWebContentsId(): number }).getWebContentsId() === target.guest.webContentsId
  }
  const before = owner.activeElement
  const onFocusOut = (event: FocusEvent) => {
    const lost = event.target
    setTimeout(() => {
      if (taken() && lost instanceof HTMLElement && lost.isConnected) lost.focus({ preventScroll: true })
    }, 0)
  }
  owner.addEventListener('focusout', onFocusOut, true)
  return () => {
    owner.removeEventListener('focusout', onFocusOut, true)
    // Nothing had focus to lose (no focusout): leave the guest unfocused.
    if (taken() && !(before instanceof HTMLElement && before.tagName === 'WEBVIEW')) (owner.activeElement as HTMLElement).blur()
  }
}

/** Two frames of the window, so a staged guest is composited. */
function nextFrames(owner: Document): Promise<void> {
  const view = owner.defaultView
  if (!view) return Promise.resolve()
  return new Promise((resolve) => view.requestAnimationFrame(() => view.requestAnimationFrame(() => resolve())))
}

export function createPageOps(deps: PageOpsDeps): PageOps {
  const { bridge } = deps

  /** Stages each runtime file on this client; the driver sets the staged paths. */
  const stageUploads = async (files: unknown[]): Promise<string[]> => {
    const { fetchUpload } = deps
    if (!fetchUpload) throw new Error('browser-upload-unavailable')
    const staged: string[] = []
    for (const path of files) {
      if (typeof path !== 'string') throw new Error('browser-upload-file-required')
      const file = await fetchUpload(path)
      staged.push(await bridge.stageUpload(file.name, file.bytes))
    }
    return staged
  }

  return {
    async execute(target, method, args) {
      const unstage = target.hidden ? target.stage?.() : undefined
      try {
        let methodArgs = target.hidden && !unstage ? { ...args, _hidden: true } : args
        if (method === 'upload' && Array.isArray(methodArgs.files)) methodArgs = { ...methodArgs, files: await stageUploads(methodArgs.files) }
        await bridge.attach(target.guest)
        if (unstage) await nextFrames(target.document)
        target.check()
        if (!BROWSER_ACTION_METHODS.has(method)) return await bridge.execute(target.guest, method, methodArgs)
        const release = keepFocus(target)
        try {
          return await bridge.execute(target.guest, method, methodArgs)
        } finally {
          release()
        }
      } finally {
        unstage?.()
      }
    },
    async download(target, url) {
      await bridge.download(target.guest, url)
    },
  }
}
