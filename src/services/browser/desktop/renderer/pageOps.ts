// Page operations on this client's pages (architecture 10.2): the `page.*`
// requests a browser session sends its driving client, run through the page
// bridge on a guest the panel's page host has ready. Choosing what to do is
// the runtime's (page control); this moves files a file input needs to this
// client. Page rendering and agent input stay inside the engine.

import { type BrowserDriverResult } from '../../contract/automation'
import type { BrowserGuestRef, BrowserPageBridge } from '../../contract/pageBridge'

/** A tab's page, ready for a page operation. */
export interface PageOpTarget {
  guest: BrowserGuestRef
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
      let methodArgs = args
      if (method === 'upload' && Array.isArray(args.files)) methodArgs = { ...args, files: await stageUploads(args.files) }
      await bridge.attach(target.guest)
      target.check()
      // Offscreen rendering and focus emulation live in the engine. An agent
      // never needs to stage a DOM surface or borrow the user's focus.
      return bridge.execute(target.guest, method, methodArgs)
    },
    async download(target, url) {
      await bridge.download(target.guest, url)
    },
  }
}
