// The editor's client entry: registers the view, the close guard that asks
// about unsaved edits and the tab menu's path copies; the shell installs the
// font settings source.

import { registerPanelCloseGuard, registerPanelView } from '@client/host'
import { registerTabMenuItems } from '@client/layout/dock'
import { editorCloseGuard } from './closeGuard'
import { editorTabMenu } from './tabMenu'

registerPanelView('editor', () => import('./EditorView'))
registerPanelCloseGuard('editor', editorCloseGuard)
registerTabMenuItems(editorTabMenu)

export { installEditorSettings, type EditorSettingsSource } from './editorSettings'
export { closeEditor, confirmUnsaved } from './editorActions'
export { editorCloseGuard } from './closeGuard'
