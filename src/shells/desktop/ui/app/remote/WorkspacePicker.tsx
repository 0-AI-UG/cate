// "Open…": one list of everywhere a workspace can come from: a folder of
// this device (first, so Enter opens the folder dialog), saved SSH machines, the hosts of the SSH config, WSL
// distros and adding one by its ssh command; then joining a workspace on
// another device with a code. Arrows and Enter pick. A saved
// machine is removed from its row. The Open dialog shows it.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { KeyRound, Monitor, Plus, Server, X } from 'lucide-react'
import { clientUi } from '@kernel/interaction'
import { inputCls } from '../../kernel/interaction'
import { useClientSetting } from '../../kernel/settings'
import { formatSshTarget, parseSshCommand, type Machine, type SshConfigHost } from '@runtime/daemon/contract'
import { clientApp } from '../app'
import { useDesktopPort } from '../desktop'
import { openLocalFolder } from '../navigation'
import { useUIStore } from '../state/uiStore'
import { forgetMachine } from './machines'

interface PickerItem {
  key: string
  section: 'Machines' | 'Other devices'
  /** An action rather than a place (adding a machine, joining). */
  always?: boolean
  icon: ReactNode
  label: string
  detail?: string
  hint?: string
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
  const app = clientApp()
  const port = useDesktopPort()
  const setup = app.machines
  const saved = useClientSetting('sshMachines')
  const [hosts, setHosts] = useState<SshConfigHost[]>([])
  const [distros, setDistros] = useState<string[]>([])
  const [active, setActive] = useState(0)
  const [adding, setAdding] = useState<string | null>(null)
  const [addError, setAddError] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    setup?.sshHosts().then((list) => { if (live) setHosts(list) }, () => {})
    setup?.wslDistros().then((list) => { if (live) setDistros(list) }, () => {})
    return () => { live = false }
  }, [setup])

  const items = useMemo(() => {
    const ui = useUIStore.getState()
    // A machine's folders and joining open their own dialog over this one:
    // the picker closes only once that one opens something.
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
    const out: PickerItem[] = []
    if (port) {
      out.push({ key: 'this', section: 'Machines', icon: <Monitor size={14} />, label: 'Open a folder…', detail: 'This device', run: () => void pickFolder() })
    }
    if (setup) {
      const savedKeys = new Set(saved.map((m) => formatSshTarget(m.target)))
      for (const machine of saved) {
        const label = machine.target.destination
        out.push({ key: `ssh:${machine.id}`, section: 'Machines', icon: <Server size={14} />, label, detail: 'SSH', hint: 'Browse…', run: openOn({ kind: 'ssh', target: machine.target }), remove: () => void removeMachine(machine.id, label) })
      }
      for (const host of hosts) {
        const target = { destination: host.alias }
        if (savedKeys.has(formatSshTarget(target))) continue
        out.push({ key: `config:${host.alias}`, section: 'Machines', icon: <Server size={14} />, label: host.alias, detail: 'SSH config', hint: 'Browse…', run: openOn({ kind: 'ssh', target }) })
      }
      for (const distro of distros) {
        out.push({ key: `wsl:${distro}`, section: 'Machines', icon: <Server size={14} />, label: distro, detail: 'WSL', hint: 'Browse…', run: openOn({ kind: 'wsl', distro }) })
      }
      out.push({ key: 'add-ssh', section: 'Machines', always: true, icon: <Plus size={14} />, label: 'Add an SSH machine…', run: () => { setAdding(''); setAddError(null) } })
    }
    if (app.pair) {
      out.push({ key: 'join', section: 'Other devices', always: true, icon: <KeyRound size={14} />, label: 'Join with a code…', run: () => ui.openJoinDialog() })
    }
    return out
  }, [hosts, distros, saved, port, setup, onPicked, app])

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
        aria-label="Machines"
        tabIndex={0}
        autoFocus={autoFocus}
        onKeyDown={(e) => {
          // The SSH command field and the rows' buttons keep their own keys.
          if (e.target !== e.currentTarget) return
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, items.length - 1)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
          if (e.key === 'Enter') { e.preventDefault(); items[active]?.run() }
        }}
        className={`min-h-0 overflow-y-auto outline-none ${listClassName}`}>
        {items.map((item, index) => {
          const header = item.section !== lastSection ? item.section : null
          lastSection = item.section
          return (
            <div key={item.key} className="relative group">
              {header && <div className="px-2 pt-3 pb-1 text-[11px] font-semibold text-muted">{header}</div>}
              {item.key === 'add-ssh' && adding !== null ? (
                <form
                  className="flex flex-col gap-1 px-2 py-1"
                  onSubmit={(e) => {
                    e.preventDefault()
                    addMachine()
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span className="shrink-0 text-muted">{item.icon}</span>
                    <input
                      autoFocus
                      aria-label="SSH command"
                      value={adding}
                      onChange={(e) => { setAdding(e.target.value); setAddError(null) }}
                      placeholder="ssh user@example.com -p 22"
                      className={`${inputCls} font-mono`}
                    />
                    <button type="submit" disabled={!adding.trim()} className="shrink-0 rounded-md px-2 py-1 text-[13px] text-primary hover:bg-hover disabled:opacity-50">Connect</button>
                  </div>
                  {addError && <span role="alert" className="pl-6 text-xs text-danger">{addError}</span>}
                </form>
              ) : (
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  data-active={index === active}
                  onMouseMove={() => setActive(index)}
                  onClick={() => item.run()}
                  className={`w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left ${index === active ? 'bg-hover' : ''}`}
                >
                  <span className="shrink-0 text-muted">{item.icon}</span>
                  <span className={`text-[13px] truncate ${item.always ? 'text-secondary' : 'text-primary'}`}>{item.label}</span>
                  {item.detail && <span className="min-w-0 text-xs text-muted truncate">{item.detail}</span>}
                  {item.hint && <span className={`ml-auto shrink-0 text-xs text-secondary ${item.remove ? 'mr-6' : ''} ${index === active ? '' : 'opacity-0 group-hover:opacity-100'}`}>{item.hint}</span>}
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
          )
        })}
      </div>
    </div>
  )
}
