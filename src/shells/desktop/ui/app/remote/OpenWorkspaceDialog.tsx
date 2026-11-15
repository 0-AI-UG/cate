// The "Open…" picker: a modal; nothing while the page shows the picker itself
// (the welcome page focuses its own). It steps aside for a machine’s folder dialog and
// comes back when that dialog is dismissed; joining stays inline.

import { FolderOpen } from 'lucide-react'
import { ListDialog } from '../../kernel/interaction'
import { useUIStore } from '../state/uiStore'
import { WorkspacePicker } from './WorkspacePicker'

export function OpenWorkspaceDialog(): JSX.Element | null {
  const open = useUIStore((s) => s.openDialogOpen && !s.pickerOnPage && !s.machineFolder)
  if (!open) return null
  const close = () => useUIStore.getState().closeWorkspacePicker()
  return (
    <ListDialog onClose={close} ariaLabel="Open a workspace" width={560} icon={<FolderOpen size={16} />} title="Open a workspace"
      hints={[
        { keys: ['↑', '↓'], label: 'Navigate' },
        { keys: ['Enter'], label: 'Open' },
        { keys: ['Esc'], label: 'Close' },
      ]}>
      <WorkspacePicker autoFocus onPicked={close} listClassName="max-h-[54vh]" />
    </ListDialog>
  )
}
