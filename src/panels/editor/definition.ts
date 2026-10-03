// The editor panel type (architecture 11.3): one file, shown as text through
// its shared buffer or as a preview. Pure: the daemon imports it.

import { channel } from '@kernel/rpc/contract'
import { storedShortcut } from '@kernel/interaction/contract'
import { definePanel, type PanelCreateOptions } from '@panels/framework/contract'
import type { JsonObject } from '@workspace/document/contract'
import { pathDisplayName } from '@workspace/files/contract'
import { isPreviewPath } from '@workspace/relations/contract'
import { editorApi, type EditorOp, type EditorSnapshot } from './contract'

interface EditorCreateOptions extends PanelCreateOptions {
  filePath?: string
  /** Shows only the file tree (the `treeOnly` field). */
  treeOnly?: boolean
}

const filePathOf = (fields: Record<string, unknown>): string | undefined =>
  typeof fields.filePath === 'string' && fields.filePath ? fields.filePath : undefined

const editorFields = ({ filePath, treeOnly }: EditorCreateOptions): JsonObject => ({
  ...(filePath ? { filePath } : {}),
  ...(treeOnly ? { treeOnly: true } : {}),
})

export const editorDefinition = definePanel({
  type: 'editor',
  label: 'Files',
  icon: 'folders',
  defaultSize: { width: 600, height: 500 },
  minimumSize: { width: 300, height: 250 },
  dropSize: { width: 540, height: 420 },
  canLiveOnCanvas: true,
  navigable: true,
  opens: ['file'],
  creation: { order: 0, title: 'New Files Panel', key: storedShortcut('n', { command: true }), toolbar: true, inWorktree: true },
  defaultTitle: 'Untitled',
  channel: channel<EditorSnapshot, Partial<EditorSnapshot>, EditorOp>(),
  api: editorApi,
  fields: (options: EditorCreateOptions) => editorFields(options),
  create: (options: EditorCreateOptions, kit) => {
    const { filePath } = options
    const record = kit.record('editor', {
      id: kit.newId(),
      // A file decides its own checkout; an explicit worktree scopes an untitled editor.
      worktreeId: filePath ? kit.worktreeIdForPath(filePath) : options.worktreeId,
      title: options.title ?? ((filePath && pathDisplayName(filePath)) || 'Untitled'),
      fields: editorFields(options),
    })
    return kit.add(record, options)
  },
  checkoutPath: (record) => filePathOf(record.fields),
  describe: (record) => filePathOf(record.fields),
  claimsShortcuts: ['saveFile', 'toggleFileExplorer', 'toggleSearch'],
  commands: [
    { id: 'editor.save', title: 'Save File', op: { kind: 'save' } },
  ],
  chrome: { flushTabBar: true },
  relation: {
    produces: 'changes',
    targetOptions: (source) => source.role.execution
      ? ['use', 'context', 'verify']
      : source.role.produces === 'notes' ? [['use', 'Address in'], 'context', 'verify'] : ['context', 'use', 'verify'],
    instruction(kind, panel) {
      const file = filePathOf(panel.fields)
      if (!file) return undefined
      const path = JSON.stringify(file)
      const verb = kind === 'use' ? 'Work in' : kind === 'verify' ? 'Verify against' : 'Reference'
      return `${verb} ${path}. Use your normal filesystem tools.`
    },
    sharesFile: (panel) => {
      const file = filePathOf(panel.fields)
      return !file || !isPreviewPath(file)
    },
  },
})

export default editorDefinition
