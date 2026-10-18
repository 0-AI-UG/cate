// The "Open…" dialog: the workspace picker in a modal. It steps aside while
// a dialog started from it (a machine's folders, joining) is open, and comes
// back when that one is dismissed.

import { FolderOpen } from 'lucide-react'
import { Modal } from '../../kernel/interaction'
import { useUIStore } from '../state/uiStore'
import { WorkspacePicker } from './WorkspacePicker'

export function OpenWorkspaceDialog(): JSX.Element | null {
  const open = useUIStore((s) => s.openDialogOpen && !s.machineFolder && !s.joinDialog)
  if (!open) return null
  const close = () => useUIStore.getState().closeWorkspacePicker()
  return (
    <Modal onClose={close} width={560} icon={<FolderOpen size={16} />} title="Open a workspace" bodyClassName="min-h-0 flex flex-col p-3">
      <WorkspacePicker autoFocus onPicked={close} listClassName="max-h-[60vh]" />
    </Modal>
  )
}
