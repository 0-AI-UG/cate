// "Open…": one list of everywhere a workspace can come from. Recent
// workspaces first, then machines: this device (a folder picker), saved SSH
// machines, the hosts of the SSH config, WSL distros and adding one by its
// ssh command; then joining a workspace on another device with a code. Typing filters; arrows and Enter pick. The Open
// dialog shows it, and so does the welcome screen.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Folder, KeyRound, Link2, Monitor, Plus, Server } from 'lucide-react'
import { inputCls } from '../../kernel/interaction'
import { useClientSetting } from '../../kernel/settings'
import { formatSshTarget, parseSshCommand, type Machine, type SshConfigHost } from '@runtime/daemon/contract'
import { machineOf, type WorkspaceEntry } from '@client/workspaces'
import { useWorkspaceList } from '../../client/workspaces'
import { clientApp } from '../app'
import { useDesktopPort } from '../desktop'
import { pickAndOpenFolder, selectWorkspace } from '../navigation'
import { useUIStore } from '../state/uiStore'

interface PickerItem {
  key: string
  section: 'Recent' | 'Machines' | 'Other devices'
  /** Shown whatever is typed (adding a machine, joining). */
  always?: boolean
  icon: ReactNode
  label: string
  detail?: string
  hint?: string
  run(): void
}

const RECENT_SHOWN = 8

/** When it was opened last (a paired one never opened: when it paired). */
const recency = (e: WorkspaceEntry): number => (e.kind === 'paired' ? e.lastOpenedAt ?? e.pairedAt : e.lastOpenedAt)

/** Where a workspace is, under its name. */
export function entryDetail(entry: WorkspaceEntry, thisMachine: string): string {
  const machine = machineOf(entry)
  if (entry.kind === 'paired') return machine.kind === 'paired' && machine.label ? `Paired · ${machine.label}` : 'Paired'
  const parent = entry.root.split(/[\\/]/).slice(0, -1).join('/') || '/'
  return machine.kind === 'machine' ? `${machine.label} · ${parent}` : `${thisMachine} · ${parent}`
}

export function entryIcon(entry: WorkspaceEntry, size = 14): ReactNode {
  if (entry.kind === 'paired') return <Link2 size={size} />
  if (entry.kind === 'machine') return <Server size={size} />
  return <Folder size={size} />
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
  const thisMachine = port?.thisMachineName ?? 'This device'
  const { entries } = useWorkspaceList(app.workspaces)
  const saved = useClientSetting('sshMachines')
  const [hosts, setHosts] = useState<SshConfigHost[]>([])
  const [distros, setDistros] = useState<string[]>([])
  const [query, setQuery] = useState('')
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
    const done = (run: () => void) => () => { onPicked?.(); run() }
    const openOn = (machine: Machine) => done(() => ui.openMachineFolder(machine))
    const out: PickerItem[] = []
    const q = query.trim().toLowerCase()
    const matches = (...words: (string | undefined)[]) => !q || words.some((w) => w?.toLowerCase().includes(q))

    const recent = entries.filter((e) => matches(e.name, entryDetail(e, thisMachine))).sort((a, b) => recency(b) - recency(a))
    for (const entry of q ? recent : recent.slice(0, RECENT_SHOWN)) {
      out.push({ key: entry.id, section: 'Recent', icon: entryIcon(entry), label: entry.name, detail: entryDetail(entry, thisMachine), run: done(() => void selectWorkspace(entry.id)) })
    }

    if (port && matches(thisMachine, 'local folder')) {
      out.push({ key: 'this', section: 'Machines', icon: <Monitor size={14} />, label: thisMachine, hint: 'Choose folder…', run: done(() => void pickAndOpenFolder()) })
    }
    if (setup) {
      const savedKeys = new Set(saved.map((m) => formatSshTarget(m.target)))
      for (const machine of saved) {
        const label = machine.target.destination
        if (matches(label, machine.lastPath)) {
          out.push({ key: `ssh:${machine.id}`, section: 'Machines', icon: <Server size={14} />, label, detail: 'SSH', hint: 'Browse…', run: openOn({ kind: 'ssh', target: machine.target }) })
        }
      }
      for (const host of hosts) {
        const target = { destination: host.alias }
        if (savedKeys.has(formatSshTarget(target)) || !matches(host.alias, host.hostName, host.user)) continue
        out.push({ key: `config:${host.alias}`, section: 'Machines', icon: <Server size={14} />, label: host.alias, detail: 'SSH config', hint: 'Browse…', run: openOn({ kind: 'ssh', target }) })
      }
      for (const distro of distros) {
        if (!matches(distro, 'wsl')) continue
        out.push({ key: `wsl:${distro}`, section: 'Machines', icon: <Server size={14} />, label: distro, detail: 'WSL', hint: 'Browse…', run: openOn({ kind: 'wsl', distro }) })
      }
      out.push({ key: 'add-ssh', section: 'Machines', always: true, icon: <Plus size={14} />, label: 'Add an SSH machine…', run: () => { setAdding(''); setAddError(null) } })
    }
    if (app.pair) {
      out.push({ key: 'join', section: 'Other devices', always: true, icon: <KeyRound size={14} />, label: 'Join with a code…', run: done(() => ui.openJoinDialog()) })
    }
    return out
  }, [entries, hosts, distros, saved, query, port, setup, thisMachine, onPicked, app])

  useEffect(() => { setActive(0) }, [query])
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView?.({ block: 'nearest' })
  }, [active])

  const addMachine = () => {
    const parsed = parseSshCommand(adding ?? '')
    if (!parsed.ok) return setAddError(parsed.error)
    onPicked?.()
    useUIStore.getState().openMachineFolder({ kind: 'ssh', target: parsed.target })
  }

  let lastSection: string | null = null
  return (
    <div className="flex flex-col min-h-0">
      <input
        autoFocus={autoFocus}
        aria-label="Search workspaces and machines"
        placeholder="Search workspaces and machines"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, items.length - 1)) }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)) }
          if (e.key === 'Enter') { e.preventDefault(); items[active]?.run() }
        }}
        className={inputCls}
      />
      <div ref={listRef} role="listbox" aria-label="Workspaces and machines" className={`mt-2 min-h-0 overflow-y-auto ${listClassName}`}>
        {items.map((item, index) => {
          const header = item.section !== lastSection ? item.section : null
          lastSection = item.section
          return (
            <div key={item.key}>
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
                  className={`group w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left ${index === active ? 'bg-hover' : ''}`}
                >
                  <span className="shrink-0 text-muted">{item.icon}</span>
                  <span className={`text-[13px] truncate ${item.always ? 'text-secondary' : 'text-primary'}`}>{item.label}</span>
                  {item.detail && <span className="min-w-0 text-xs text-muted truncate">{item.detail}</span>}
                  {item.hint && <span className={`ml-auto shrink-0 text-xs text-secondary ${index === active ? '' : 'opacity-0 group-hover:opacity-100'}`}>{item.hint}</span>}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
