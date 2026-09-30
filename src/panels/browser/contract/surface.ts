// Page operations the browser session asks its driving client to run
// (`withSurface`, architecture 10.2). The client's view routes each one to
// the webview of `tabId` and the desktop page driver.

import type { BrowserCodeResult, BrowserDriverResult } from '@services/browser/contract'

export type BrowserSurfaceRequests = {
  /** Mounts the tab's page if needed, waits until the view has followed the
   *  tab's navigation `nav` and the page stopped loading. */
  'page.ready': { args: { tabId: string; nav: number; timeoutMs?: number }; result: { url: string; title: string } }
  /** Back, forward or reload on this client's page. `ok` is false without history. */
  'page.history': { args: { tabId: string; action: 'back' | 'forward' | 'reload' | 'reloadHard' }; result: { ok: boolean } }
  /** One page-driver method (observations, actions, waits). `settle` waits
   *  for layout first (after a viewport change). */
  'page.execute': { args: { tabId: string; method: string; args: Record<string, unknown>; settle?: boolean }; result: BrowserDriverResult }
  /** Downloads `url` through the tab's partition. */
  'page.download': { args: { tabId: string; url: string }; result: { url: string } }
  /** Runs a `cate.browser.run` cell in this client's code session for `key`. */
  'code.run': { args: { key: string; cellId: string; code: string; deadlineMs: number }; result: BrowserCodeResult }
  'code.reset': { args: { key: string }; result: void }
}

export type BrowserSurfaceOp = keyof BrowserSurfaceRequests
export type BrowserSurfaceArgs<Op extends BrowserSurfaceOp> = BrowserSurfaceRequests[Op]['args']
export type BrowserSurfaceResult<Op extends BrowserSurfaceOp> = BrowserSurfaceRequests[Op]['result']
