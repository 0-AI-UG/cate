// Page operations on this client's pages (architecture 10.2): the `page.*`
// requests a browser session sends its driving client, run through the page
// bridge on a guest the panel's page host has ready. Choosing what to do is
// the runtime's (page control); this moves files a file input needs to this
// client and keeps the person's focus where it was while an agent acts.

import { BROWSER_ACTION_METHODS, type BrowserDriverResult } from '../../contract/automation'
import type { BrowserGuestRef, BrowserPageBridge } from '../../contract/pageBridge'

/** A tab's page, ready for a page operation. */
export interface PageOpTarget {
  guest: BrowserGuestRef
  /** The document the guest's <webview> lives in. */
  document: Document
  /** A parked guest (its panel off screen) paints nothing to capture. */
  hidden: boolean
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

/** Agent actions in flight across every browser in this window. A click
 *  focuses its guest; the element focused before the first action gets focus
 *  back after the last, so a user typing elsewhere keeps typing there. */
const focusLoan = { actions: 0, before: null as Element | null }

function returnFocus(owner: Document): void {
  const { before } = focusLoan
  const active = owner.activeElement
  if (active === before || !(active instanceof HTMLElement) || active.tagName !== 'WEBVIEW') return
  if (before instanceof HTMLElement && before !== owner.body && before.isConnected) before.focus({ preventScroll: true })
  else active.blur()
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
      let methodArgs = target.hidden ? { ...args, _hidden: true } : args
      if (method === 'upload' && Array.isArray(methodArgs.files)) methodArgs = { ...methodArgs, files: await stageUploads(methodArgs.files) }
      await bridge.attach(target.guest)
      target.check()
      if (!BROWSER_ACTION_METHODS.has(method)) return bridge.execute(target.guest, method, methodArgs)
      if (focusLoan.actions++ === 0) focusLoan.before = target.document.activeElement
      try {
        return await bridge.execute(target.guest, method, methodArgs)
      } finally {
        if (--focusLoan.actions === 0) returnFocus(target.document)
      }
    },
    async download(target, url) {
      await bridge.download(target.guest, url)
    },
  }
}
