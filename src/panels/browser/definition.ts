// The browser panel type (architecture 10.2, 11.3). Pure: the daemon imports it.

import { channel } from '@kernel/rpc/contract'
import { definePanel, type PanelCreateOptions } from '@panels/framework/contract'
import type { JsonObject } from '@workspace/document/contract'
import { browserApi, type BrowserOp, type BrowserSnapshot } from './contract'

/** A browser on `url`; the start page when omitted. */
interface BrowserCreateOptions extends PanelCreateOptions {
  url?: string
}

export default definePanel({
  type: 'browser',
  label: 'Browser',
  icon: 'globe',
  defaultSize: { width: 800, height: 600 },
  minimumSize: { width: 400, height: 300 },
  dropSize: { width: 640, height: 440 },
  canLiveOnCanvas: true,
  worktreeBinding: false,
  navigable: true,
  splitMenuOrder: 2,
  // The webview is the page: keep it mounted while its canvas card is culled or
  // its dock tab is hidden, so page state stays the same for user and agent.
  surface: { retention: 'workspace' },
  requiresFolder: false,
  requires: ['webview'],
  opens: ['url'],
  defaultTitle: 'Browser',
  fields: (options: BrowserCreateOptions): JsonObject => (options.url ? { url: options.url } : {}),
  channel: channel<BrowserSnapshot, Partial<BrowserSnapshot>, BrowserOp>(),
  api: browserApi,
  // Cmd+R reloads; Cmd+=/- zoom the page, not the canvas.
  claimsShortcuts: ['renamePanel', 'zoomIn', 'zoomOut', 'zoomReset'],
  commands: [
    { id: 'reload', title: 'Browser: Reload', shortcut: '⌘R', op: { kind: 'history', action: 'reload' } },
    { id: 'reloadHard', title: 'Browser: Force Reload', shortcut: '⇧⌘R', op: { kind: 'history', action: 'reloadHard' } },
    { id: 'back', title: 'Browser: Back', shortcut: '⌘[', op: { kind: 'history', action: 'back' } },
    { id: 'forward', title: 'Browser: Forward', shortcut: '⌘]', op: { kind: 'history', action: 'forward' } },
  ],
  describe: (record) => (typeof record.fields.url === 'string' ? record.fields.url : undefined),
  relation: {
    produces: 'findings',
    targetOptions: (source) => source.role.execution
      ? ['use', 'verify', 'context']
      : source.role.produces === 'changes' || source.role.produces === 'notes'
        ? [['verify', 'Verify in'], 'use', 'context']
        : ['context', 'verify', 'use'],
    instruction: (kind) => `${kind === 'verify' ? 'Verify with it' : kind === 'context' ? 'Use it as supporting context' : 'Use it'} through Cate browser automation; don't open another browser.`,
  },
})
