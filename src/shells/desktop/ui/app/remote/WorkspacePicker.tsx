// Recent workspaces first, followed by opening a folder, browsing another
// computer and joining a shared workspace. Arrows and Enter pick an item.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Folder, Globe, Plus, Server, X } from 'lucide-react'
import { clientUi, errorMessage, shortcutDisplay } from '@kernel/interaction'
import { Kbd, useResolvedShortcuts } from '../../kernel/interaction'
import { useClientSetting } from '../../kernel/settings'
import { formatSshTarget, parseSshCommand, type Machine, type SshConfigHost } from '@runtime/daemon/contract'
import { clientApp } from '../app'
import { useDesktopPort } from '../desktop'
import { useRecentWorkspaces } from '../../client/workspaces'
import { machineOf, type WorkspaceEntry } from '@client/workspaces'
import { openLocalFolder, selectWorkspace } from '../navigation'
import { useUIStore } from '../state/uiStore'
import { InlineJoinForm } from '../pairing/InlineJoinForm'
import { InlinePickerInput } from './InlinePickerInput'
import { forgetMachine } from './machines'

interface PickerItem {
  key: string
  section: 'Recent workspaces' | 'Shared with you' | 'Open' | 'Other computers'
  /** An action rather than a place (adding a machine, joining). */
  always?: boolean
  icon: ReactNode
  label: string
  detail?: string
  hint?: string
  /** The bound key of the action this row runs. */
  shortcut?: string
  run(): void
  /** Forgets it (saved machines). */
  remove?: () => void
}

export function WorkspacePicker({ autoFocus = false, onPicked, listClassName = '' }: {
  autoFocus?: boolean
  /** Bounds the list's height (it scrolls past it). */
  listClassName?: string
  /** Something was picked (the dialog closes). */
  onPicked?: () => void
}): JSX.Element {
  const request = useUIStore((state) => state.joinRequest)
  const app = clientApp()
  const port = useDesktopPort()
  const entries = useRecentWorkspaces(app.workspaces)
  const setup = app.machines
  const saved = useClientSetting('sshMachines')
  const [hosts, setHosts] = useState<SshConfigHost[]>([])
  const [distros, setDistros] = useState<string[]>([])
  const [active, setActive] = useState(0)
  const [adding, setAdding] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (request) { setAdding(null); setAddError(null) }
  }, [request])

  useEffect(() => {
    let live = true
    setup?.sshHosts().then((list) => { if (live) setHosts(list) }, () => {})
    setup?.wslDistros().then((list) => { if (live) setDistros(list) }, () => {})
    return () => { live = false }
  }, [setup])

  const shortcuts = useResolvedShortcuts()
  const items = useMemo(() => {
    const ui = useUIStore.getState()
    // Machine folders open their own dialog; joining stays inline.
    const openOn = (machine: Machine) => () => ui.openMachineFolder(machine)
    // The picker stays when the native folder dialog is cancelled.
    const pickFolder = async () => {
      const root = await port?.pickFolder()
      if (!root) return
      onPicked?.()
      await openLocalFolder(root)
    }
    const removeMachine = async (id: string, label: string) => {
      if (await clientUi().confirm(`Remove ${label}? Its workspaces stay in the sidebar.`)) forgetMachine(id)
    }
    const reopen = async (id: string) => {
      try {
        await app.workspaces.restore(id)
        onPicked?.()
        await selectWorkspace(id)
      } catch (err) {
        clientUi().showError(errorMessage(err, 'Could not reopen the workspace.'))
      }
    }
    const forgetWorkspace = async (entry: WorkspaceEntry) => {
      const message = entry.kind === 'paired'
        ? `Remove "${entry.name}" from recents and forget its access? Joining again will need a new invite.`
        : `Remove "${entry.name}" from recents?`
      if (!await clientUi().confirm(message)) return
      try {
        await app.workspaces.forget(entry.id)
      } catch (err) {
        clientUi().showError(errorMessage(err, 'Could not remove the workspace.'))
      }
    }
    const out: PickerItem[] = entries.map((entry) => {
      const location = machineOf(entry)
      return {
        key: entry.id,
        section: entry.kind === 'paired' ? 'Shared with you' : 'Recent workspaces',
        icon: entry.kind === 'paired' ? <Globe size={14} /> : <Folder size={14} />, label: entry.name,
        detail: 'label' in location ? location.label ?? 'Remote computer' : undefined,
        run: () => void reopen(entry.id),
        remove: () => void forgetWorkspace(entry),
      }
    })
    if (port) {
      out.push({ key: 'this', section: 'Open', icon: <Folder size={14} />, label: 'Open Folder…', detail: 'This device', shortcut: shortcutDisplay(shortcuts, 'openFolder') ?? undefined, run: () => void pickFolder() })
    }
    if (setup) {
      const savedKeys = new Set(saved.map((m) => formatSshTarget(m.target)))
      for (const machine of saved) {
        const label = machine.target.destination
        out.push({ key: `ssh:${machine.id}`, section: 'Other computers', icon: <Server size={14} />, label, detail: 'SSH', hint: 'Browse…', run: openOn({ kind: 'ssh', target: machine.target }), remove: () => void removeMachine(machine.id, label) })
      }
      for (const host of hosts) {
        const target = { destination: host.alias }
        if (savedKeys.has(formatSshTarget(target))) continue
        out.push({ key: `config:${host.alias}`, section: 'Other computers', icon: <Server size={14} />, label: host.alias, detail: 'SSH config', hint: 'Browse…', run: openOn({ kind: 'ssh', target }) })
      }
      for (const distro of distros) {
        out.push({ key: `wsl:${distro}`, section: 'Other computers', icon: <Server size={14} />, label: distro, detail: 'WSL', hint: 'Browse…', run: openOn({ kind: 'wsl', distro }) })
      }
      out.push({ key: 'add-ssh', section: 'Other computers', always: true, icon: <Plus size={14} />, label: 'Add an SSH machine…', run: () => { ui.closeJoinInput(); setAdding(''); setAddError(null) } })
    }
    if (app.pair) {
      out.push({ key: 'join', section: 'Shared with you', always: true, icon: <Globe size={14} />, label: 'Join Workspace…', shortcut: shortcutDisplay(shortcuts, 'joinWorkspace') ?? undefined, run: () => ui.openJoinInput() })
    }
    // Sections stay contiguous; shared recents and joining close the list.
    const order = ['Recent workspaces', 'Open', 'Other computers', 'Shared with you']
    return out.sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section))
  }, [entries, hosts, distros, saved, port, setup, onPicked, app, shortcuts])

  useEffect(() => { setActive((index) => Math.min(index, Math.max(0, items.length - 1))) }, [items.length])

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  const addMachine = () => {
    const parsed = parseSshCommand(adding ?? '')
    if (!parsed.ok) return setAddError(parsed.error)
    useUIStore.getState().openMachineFolder({ kind: 'ssh', target: parsed.target })
  }

  let lastSection: string | null = null
  return (
    <div className="flex flex-col min-h-0">
      <div
        ref={listRef}
        role="listbox"
        aria-label="Open a workspace"
        tabIndex={0}
        autoFocus={autoFocus}
        onKeyDown={(e) => {
          // The SSH command field and the rows' buttons keep their own keys.
          if (e.target !== e.currentTarget) return
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, items.length - 1)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
          if (e.key === 'Enter') { e.preventDefault(); items[active]?.run() }
          // 1-9 pick the row with that number.
          if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey && items[Number(e.key) - 1]) { e.preventDefault(); items[Number(e.key) - 1].run() }
        }}
        className={`min-h-0 overflow-y-auto outline-none ${listClassName}`}>
        {items.map((item, index) => {
          const header = item.section !== lastSection ? item.section : null
          lastSection = item.section
          const shared = item.section === 'Shared with you'
          const last = items[index + 1]?.section !== item.section
          return (
            <div key={item.key} className={`group ${shared ? `mx-1 bg-[color-mix(in_srgb,var(--text-primary)_5%,transparent)] border-x border-subtle px-1 ${header ? 'mt-3 rounded-t-lg border-t' : ''} ${last ? 'rounded-b-lg border-b pb-1' : ''}` : ''}`}>
              {header && (shared
                ? <div className="flex items-center gap-1.5 px-1.5 pt-2.5 pb-1 text-[12px] font-medium text-primary"><Globe size={12} />{header}</div>
                : <div className="px-2.5 pt-3 pb-1 text-[12px] font-medium text-muted">{header}</div>)}
              <div className="relative">
                {item.key === 'join' && request ? (
                  <InlineJoinForm key={`${request.code ?? ''}|${request.machine ?? ''}`} request={request} />
                ) : item.key === 'add-ssh' && adding !== null ? (
                  <InlinePickerInput
                    icon={item.icon}
                    label="SSH command"
                    placeholder="ssh user@example.com -p 22"
                    value={adding}
                    onChange={(value) => { setAdding(value); setAddError(null) }}
                    onSubmit={addMachine}
                    onCancel={() => { setAdding(null); setAddError(null) }}
                    actionLabel="Connect"
                    error={addError}
                  />
                ) : (
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === active}
                    data-active={index === active}
                    onMouseMove={() => setActive(index)}
                    onClick={() => item.run()}
                    className={`w-full min-h-8 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left ${shared ? 'pr-[19px]' : 'pr-7'} ${index === active ? 'bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)]' : ''}`}
                  >
                    <span className="shrink-0 text-muted">{item.icon}</span>
                    <span className={`text-[13px] truncate ${item.always ? 'text-secondary' : 'text-primary'}`}>{item.label}</span>
                    {item.detail && <span className="min-w-0 text-[12px] text-[color-mix(in_srgb,var(--text-muted)_85%,transparent)] truncate">{item.detail}</span>}
                    {item.shortcut && <span className={`ml-auto flex shrink-0 items-center gap-1`}>{(item.shortcut.includes('+') ? item.shortcut.split('+') : [...item.shortcut]).map((key, n) => <Kbd key={n}>{key}</Kbd>)}</span>}
                    {item.hint && <span className={`ml-auto shrink-0 text-xs text-secondary ${index === active ? '' : 'opacity-0 group-hover:opacity-100'}`}>{item.hint}</span>}
                    {index < 9 && <span className={`flex shrink-0 ${item.shortcut || item.hint ? 'ml-2' : 'ml-auto'}`}><Kbd>{index + 1}</Kbd></span>}
                  </button>
                )}
                {item.remove && (
                  <button
                    type="button"
                    aria-label={`Remove ${item.label}`}
                    onClick={item.remove}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted hover:text-danger opacity-0 group-hover:opacity-100 focus:opacity-100"
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
