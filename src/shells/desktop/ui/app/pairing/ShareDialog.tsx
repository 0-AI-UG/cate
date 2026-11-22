// "Share": who can join a workspace (its network access), a one-time code
// for the next device (each one confirmed first), and the devices that joined. Picking wider access is
// the person's consent; narrower access asks first, since it cuts devices
// off (`changeNetwork`).

import { useState } from 'react'
import { Check, Users } from 'lucide-react'
import { Button, Modal } from '../../kernel/interaction'
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
  { value: 'off', label: 'Host computer only', detail: 'Only the machine the workspace runs on can open it.' },
  { value: 'sameNetwork', label: 'Nearby only', detail: 'Paired devices can join while they are on the same network.' },
  { value: 'cateConnect', label: 'Anywhere', detail: 'Invited devices can join from any network.' },
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
    <Modal numbered onClose={close} width={440} icon={<Users size={15} />} title={`Share "${name}"`} bodyClassName="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-1">
      <SharePanel workspaceId={workspaceId} onCancel={close} />
    </Modal>
  )
}

export function SharePanel({ workspaceId, onCancel }: { workspaceId: string; onCancel?: () => void }): JSX.Element {
  const network = useWorkspaceSetting(workspaceId, 'runtimeNetwork')
  // From the shown code: devices could not reach this machine on its network.
  const [problem, setProblem] = useState<SameNetworkProblem | null>(null)
  const choose = (value: RuntimeNetwork) => {
    if (value === network) return
    changeNetwork(workspaceId, network, value).catch((err: unknown) => clientUi().showError(errorMessage(err, 'Could not change who can join.')))
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-px" role="radiogroup" aria-label="Who can join">
        {ACCESS.map((option) => {
          const on = network === option.value
          return (
            <button
              key={option.value}
              type="button"
              data-menu-item
              role="radio"
              aria-checked={on}
              onClick={() => choose(option.value)}
              className={`flex min-h-8 w-full items-center gap-2.5 rounded-md px-2 py-1 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)] ${on ? 'bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)]' : ''}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-primary">{option.label}</span>
                <span className="block truncate text-[12px] text-muted">{option.detail}</span>
              </span>
              <span className="w-4 shrink-0 text-primary">{on && <Check size={14} />}</span>
            </button>
          )
        })}
        {problem && network === 'sameNetwork' && (
          <div role="alert" className="mt-1 flex items-center justify-between gap-3 px-2.5">
            <span className="text-xs text-warning">{sameNetworkProblemMessage(problem)}</span>
            <Button size="sm" variant="primary" onClick={() => choose('cateConnect')}>Use Anywhere</Button>
          </div>
        )}
      </div>
      <PairingCode workspaceId={workspaceId} onSameNetworkProblem={setProblem} onCancel={onCancel} />
      <WorkspaceDevices workspaceId={workspaceId} />
    </div>
  )
}
