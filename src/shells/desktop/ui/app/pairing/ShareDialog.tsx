// "Share": who can join a workspace (its network access), a one-time code
// for the next device, and the devices that joined. Picking wider access is
// the person's consent; narrower access asks first, since it cuts devices
// off (Runtime settings' `changeNetwork`).

import { Users } from 'lucide-react'
import { Modal } from '../../kernel/interaction'
import { clientUi, errorMessage } from '@kernel/interaction'
import { useWorkspaceSetting } from '../../kernel/settings'
import type { RuntimeNetwork } from '@runtime/daemon/contract'
import { changeNetwork } from '../../runtime/daemon'
import { clientApp } from '../app'
import { useUIStore } from '../state/uiStore'
import { PairingCode, WorkspaceDevices } from './DevicesPage'

const ACCESS: { value: RuntimeNetwork; label: string; detail: string }[] = [
  { value: 'off', label: 'Only its machine', detail: 'Nobody else can join.' },
  { value: 'sameNetwork', label: 'Same network', detail: 'Paired devices on this network.' },
  { value: 'cateConnect', label: 'Anywhere', detail: 'Paired devices, through Cate Connect.' },
]

export function ShareDialog(): JSX.Element | null {
  const workspaceId = useUIStore((s) => s.shareWorkspaceId)
  if (!workspaceId) return null
  return <OpenShareDialog workspaceId={workspaceId} />
}

function OpenShareDialog({ workspaceId }: { workspaceId: string }): JSX.Element {
  const close = () => useUIStore.getState().openShare(null)
  const name = clientApp().workspaces.get(workspaceId)?.name ?? 'workspace'
  return (
    // Above Settings (z-[100001]), whose Devices page opens it too.
    <Modal onClose={close} width={520} icon={<Users size={16} />} title={`Share "${name}"`} zClassName="z-[100002]" bodyClassName="px-5 py-4 overflow-y-auto">
      <SharePanel workspaceId={workspaceId} />
    </Modal>
  )
}

export function SharePanel({ workspaceId }: { workspaceId: string }): JSX.Element {
  const network = useWorkspaceSetting(workspaceId, 'runtimeNetwork')
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium text-primary">Who can join</span>
        <div role="radiogroup" aria-label="Who can join" className="grid grid-cols-3 gap-1.5">
          {ACCESS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={network === option.value}
              onClick={() => {
                if (option.value === network) return
                changeNetwork(workspaceId, network, option.value).catch((err: unknown) => clientUi().showError(errorMessage(err, 'Could not change who can join.')))
              }}
              className={`flex flex-col items-start gap-0.5 rounded-lg border px-2.5 py-2 text-left transition-colors ${
                network === option.value ? 'border-focus-blue bg-hover' : 'border-subtle hover:bg-hover'
              }`}
            >
              <span className="text-[13px] text-primary">{option.label}</span>
              <span className="text-[11px] leading-snug text-muted">{option.detail}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-medium text-primary">Add a device</span>
        <PairingCode workspaceId={workspaceId} />
      </div>
      <WorkspaceDevices workspaceId={workspaceId} />
    </div>
  )
}
