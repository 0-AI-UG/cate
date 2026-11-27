import { registerPanelView } from '../../client/host/views'

export { useBlockText, TEXT_SAVE_DELAY_MS, type BlockText } from './useBlockText'

registerPanelView('note', () => import('./NoteView'))
