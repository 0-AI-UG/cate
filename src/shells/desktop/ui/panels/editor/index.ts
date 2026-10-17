// The editor's client entry: registers the view, the close guard that asks
// about unsaved edits and the tab menu's path copies; the shell installs the
// font settings source and starts the Files tree on workspace open.

import { registerPanelCloseGuard } from '@client/host'
import { registerPanelView } from '../../client/host/views'
import { registerTabMenuItems } from '../../client/layout/dock'
import { editorCloseGuard } from './closeGuard'
import { editorTabMenu } from './tabMenu'

registerPanelView('editor', () => import('./EditorView'))
registerPanelCloseGuard('editor', editorCloseGuard)
registerTabMenuItems(editorTabMenu)

export { installEditorSettings, type EditorSettingsSource } from './editorSettings'
export { ensureFilesTree, startFilesTreeOnOpen } from './filesTreeOnOpen'
export { closeEditor, confirmUnsaved } from './editorActions'
export { editorCloseGuard } from './closeGuard'
