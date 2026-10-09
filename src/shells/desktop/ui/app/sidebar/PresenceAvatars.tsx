// Who else is in a workspace (architecture 7.6): one small avatar per other
// client, its device's initials, the device name and what it looks at in the
// tooltip. Nothing while this client is alone.

import { useOtherClients } from '../../client/document'

const initials = (name: string): string =>
  name.split(/[\s'’-]+/).filter(Boolean).slice(0, 2).map((word) => word[0]!.toUpperCase()).join('') || '?'

const MAX_SHOWN = 3

export function PresenceAvatars({ workspaceId }: { workspaceId: string }): JSX.Element | null {
  const others = useOtherClients(workspaceId)
  if (others.length === 0) return null
  const shown = others.slice(0, MAX_SHOWN)
  const label = others.map((client) => client.device.name).join(', ')
  return (
    <span className="flex-shrink-0 flex items-center -space-x-1" aria-label={`Also here: ${label}`} title={`Also here: ${label}`}>
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
    </span>
  )
}
