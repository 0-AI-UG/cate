// A workspace row's one sharing spot, opening Share on click. It shows one
// thing at a time: who else is in the workspace (architecture 7.6), one small
// avatar per other client with its device's initials; else, while the
// workspace is open beyond its machine, who can join; else, on hover or when
// selected, a button to invite a device.

import type { MouseEvent } from 'react'
import { Globe, UserPlus, Wifi } from 'lucide-react'
import { Tooltip } from '../../kernel/interaction'
import { useWorkspaceSetting } from '../../kernel/settings'
import { useOtherClients } from '../../client/document'

const initials = (name: string): string =>
  name.split(/[\s'’-]+/).filter(Boolean).slice(0, 2).map((word) => word[0]!.toUpperCase()).join('') || '?'

const MAX_SHOWN = 3

const SLOT = 'flex-shrink-0 flex items-center justify-center focus:outline-none'

export function ShareSlot({ workspaceId, isOpen, isSelected, onShare }: {
  workspaceId: string
  isOpen: boolean
  isSelected: boolean
  onShare: () => void
}): JSX.Element {
  const others = useOtherClients(workspaceId)
  const network = useWorkspaceSetting(isOpen ? workspaceId : null, 'runtimeNetwork')
  const share = (e: MouseEvent) => { e.stopPropagation(); onShare() }

  if (isOpen && others.length > 0) {
    const label = `Also here: ${others.map((client) => client.device.name).join(', ')}`
    const shown = others.slice(0, MAX_SHOWN)
    return (
      <Tooltip label={label}>
        <button className={`${SLOT} -space-x-1`} onClick={share} aria-label={label}>
          {shown.map((client) => (
            <span
              key={client.clientId}
              className={`w-4 h-4 rounded-full bg-surface-3 border border-subtle text-[8px] font-semibold leading-none flex items-center justify-center text-secondary ${client.attentive ? '' : 'opacity-60'}`}
            >
              {initials(client.device.name)}
            </span>
          ))}
          {others.length > MAX_SHOWN && (
            <span className="w-4 h-4 rounded-full bg-surface-3 border border-subtle text-[8px] leading-none flex items-center justify-center text-muted">
              +{others.length - MAX_SHOWN}
            </span>
          )}
        </button>
      </Tooltip>
    )
  }

  if (network !== 'off') {
    const Glyph = network === 'cateConnect' ? Globe : Wifi
    const label = network === 'cateConnect' ? 'Shared: paired devices can join from anywhere' : 'Shared: paired devices can join on this network'
    return (
      <Tooltip label={label}>
        <button className={`${SLOT} w-5 h-5 text-secondary opacity-70 hover:opacity-100 hover:text-primary`} onClick={share} aria-label={label}>
          <Glyph size={12} />
        </button>
      </Tooltip>
    )
  }

  return (
    <Tooltip label="Share workspace…">
      <button
        className={`${SLOT} w-5 h-5 text-secondary hover:text-primary transition-opacity ${isSelected ? 'opacity-60' : 'opacity-0'} group-hover:opacity-80 hover:!opacity-100 focus-visible:opacity-100`}
        onClick={share}
        aria-label="Share workspace…"
      >
        <UserPlus size={13} />
      </button>
    </Tooltip>
  )
}
