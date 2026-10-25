// "Share": who can join a workspace (its network access), a one-time code
// for the next device (each one confirmed first), and the devices that joined. Picking wider access is
// the person's consent; narrower access asks first, since it cuts devices
// off (`changeNetwork`).

import { useState } from 'react'
import { Users } from 'lucide-react'
import { Button, Modal, SEGMENT } from '../../kernel/interaction'
import { clientUi, errorMessage } from '@kernel/interaction'
import { useWorkspaceSetting } from '../../kernel/settings'
import type { RuntimeNetwork } from '@runtime/daemon/contract'
import { sameNetworkProblemMessage } from '@runtime/pairing/contract'
import type { SameNetworkProblem } from '@runtime/transports/contract'
import { changeNetwork } from '../../runtime/daemon'
import { clientApp } from '../app'
import { useUIStore } from '../state/uiStore'
import { PairingCode, WorkspaceDevices } from './DevicesPage'

const ACCESS: { value: RuntimeNetwork; label: string; detail: string }[] = [
  { value: 'off', label: 'Only its machine', detail: 'Only the machine the workspace runs on can open it.' },
  { value: 'sameNetwork', label: 'Same network', detail: 'Paired devices can join while they are on the same network.' },
  { value: 'cateConnect', label: 'Anywhere', detail: 'Paired devices can join from any network, through Cate Connect.' },
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
      <SharePanel workspaceId={workspaceId} onCancel={close} />
    </Modal>
  )
}

export function SharePanel({ workspaceId, onCancel }: { workspaceId: string; onCancel?: () => void }): JSX.Element {
  const network = useWorkspaceSetting(workspaceId, 'runtimeNetwork')
  const selected = ACCESS.find((option) => option.value === network)
  // From the shown code: devices could not reach this machine on its network.
  const [problem, setProblem] = useState<SameNetworkProblem | null>(null)
  const choose = (value: RuntimeNetwork) => {
    if (value === network) return
    changeNetwork(workspaceId, network, value).catch((err: unknown) => clientUi().showError(errorMessage(err, 'Could not change who can join.')))
  }
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-medium text-primary">Who can join</span>
          <div role="radiogroup" aria-label="Who can join" className={SEGMENT.group}>
            {ACCESS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={network === option.value}
                onClick={() => choose(option.value)}
                className={SEGMENT.seg(network === option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        {problem && network === 'sameNetwork' ? (
          <div role="alert" className="flex items-center justify-between gap-3">
            <span className="text-xs text-warning">{sameNetworkProblemMessage(problem)}</span>
            <Button size="sm" variant="primary" onClick={() => choose('cateConnect')}>Use Anywhere</Button>
          </div>
        ) : selected && <span className="text-xs text-muted">{selected.detail}</span>}
      </div>
      <PairingCode workspaceId={workspaceId} onSameNetworkProblem={setProblem} onCancel={onCancel} />
      <div className="border-t border-subtle" />
      <WorkspaceDevices workspaceId={workspaceId} />
    </div>
  )
}
