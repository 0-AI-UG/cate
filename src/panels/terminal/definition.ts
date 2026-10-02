// The terminal panel type (architecture 11.3). Pure: the daemon imports it.
// Which agent a terminal hosts is the agents service's answer
// (`sessionFor(panel)`), not a definition hook.

import { channel } from '@kernel/rpc/contract'
import { storedShortcut } from '@kernel/ui/contract'
import { definePanel } from '@panels/framework/contract'
import type { JsonObject } from '@workspace/document/contract'
import { terminalApi } from './contract/api'
import type { TerminalCreateOptions, TerminalOp, TerminalSnapshot } from './contract/types'

const cwdOf = (fields: Record<string, unknown>): string | undefined =>
  typeof fields.cwd === 'string' && fields.cwd ? fields.cwd : undefined

export const terminalDefinition = definePanel({
  type: 'terminal',
  label: 'Terminal',
  icon: 'terminal',
  defaultSize: { width: 640, height: 400 },
  minimumSize: { width: 320, height: 200 },
  dropSize: { width: 520, height: 340 },
  canLiveOnCanvas: true,
  switchesWorktree: true,
  navigable: true,
  creation: { order: 1, key: storedShortcut('t', { command: true }), toolbar: true, inWorktree: true },
  requires: [],
  opens: ['directory'],
  defaultTitle: 'Terminal',
  channel: channel<TerminalSnapshot, Partial<TerminalSnapshot>, TerminalOp>(),
  api: terminalApi,
  fields: (options: TerminalCreateOptions): JsonObject => (options.cwd ? { cwd: options.cwd } : {}),
  // Titles are numbered ("Terminal 2") so CLI calls can address one panel.
  create: (options: TerminalCreateOptions, kit) => {
    const id = kit.newId()
    const record = kit.record('terminal', {
      id,
      title: options.title ? kit.uniqueTitle(options.title, id) : kit.numberedTitle('terminal', 'Terminal'),
      worktreeId: options.worktreeId ?? kit.worktreeIdForPath(options.cwd),
      fields: options.cwd ? { cwd: options.cwd } : {},
    })
    return kit.add(record, options)
  },
  checkoutPath: (record) => cwdOf(record.fields),
  ownsKeyboard: true,
  relation: { execution: true },
  commands: [
    { id: 'terminal.restart', title: 'Restart Terminal', op: { kind: 'restart' } },
    { id: 'terminal.terminate', title: 'Kill Terminal Process', op: { kind: 'terminate' } },
  ],
  describe: (record) => cwdOf(record.fields),
  chrome: { worktreeChip: true },
})

export default terminalDefinition
