import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Pulse, X, ArrowClockwise } from '@phosphor-icons/react'
import { useStatusStore } from '../stores/statusStore'
import { useAppStore, useWorkspaceList } from '../stores/appStore'

interface ProcessEntry {
  workspaceId: string
  workspaceName: string
  terminalId: string
  processName: string | null
  ports: number[]
  cwd: string | null
}

interface RecentlyClosed {
  terminalId: string
  workspaceName: string
  processName: string | null
  ports: number[]
  closedAt: number
}

const RECENTLY_CLOSED_TTL = 5 * 60 * 1000 // 5 minutes
const MAX_RECENTLY_CLOSED = 10

export const ProcessPortsButton: React.FC = () => {
  const workspaces = useWorkspaceList()
  const statusWorkspaces = useStatusStore((s) => s.workspaces)
  const terminalWorkspaceMap = useStatusStore((s) => s.terminalWorkspaceMap)
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const [recentlyClosed, setRecentlyClosed] = useState<RecentlyClosed[]>([])

  // Aggregate active processes from status store
  const activeProcesses = useMemo(() => {
    const entries: ProcessEntry[] = []
    const wsMap = new Map(workspaces.map((ws) => [ws.id, ws]))

    for (const [terminalId, workspaceId] of Object.entries(terminalWorkspaceMap)) {
      const wsStatus = statusWorkspaces[workspaceId]
      if (!wsStatus) continue

      const activity = wsStatus.terminalActivity[terminalId]
      const ports = wsStatus.listeningPorts[terminalId] ?? []
      const cwd = wsStatus.terminalCwd[terminalId] ?? null

      if ((activity && activity.type === 'running') || ports.length > 0) {
        const ws = wsMap.get(workspaceId)
        entries.push({
          workspaceId,
          workspaceName: ws?.name ?? 'Unknown',
          terminalId,
          processName: activity?.type === 'running' ? activity.processName : null,
          ports,
          cwd,
        })
      }
    }
    return entries
  }, [statusWorkspaces, terminalWorkspaceMap, workspaces])

  // Group by workspace
  const grouped = useMemo(() => {
    const map = new Map<string, { name: string; entries: ProcessEntry[] }>()
    for (const entry of activeProcesses) {
      if (!map.has(entry.workspaceId)) {
        map.set(entry.workspaceId, { name: entry.workspaceName, entries: [] })
      }
      map.get(entry.workspaceId)!.entries.push(entry)
    }
    return Array.from(map.entries())
  }, [activeProcesses])

  // Clean up expired recently-closed entries
  const validRecentlyClosed = useMemo(() => {
    const now = Date.now()
    return recentlyClosed.filter((r) => now - r.closedAt < RECENTLY_CLOSED_TTL)
  }, [recentlyClosed, open]) // re-evaluate on open

  // Badge count: terminals with listening ports
  const portCount = activeProcesses.filter((p) => p.ports.length > 0).length

  // Position the popover below the button
  useEffect(() => {
    if (!open || !buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    const popoverWidth = 280
    const margin = 8
    let left = rect.right - popoverWidth
    if (left + popoverWidth + margin > window.innerWidth) {
      left = window.innerWidth - popoverWidth - margin
    }
    if (left < margin) left = margin
    let top = rect.bottom + 6
    const estHeight = 350
    if (top + estHeight + margin > window.innerHeight) {
      top = Math.max(margin, rect.top - estHeight - 6)
    }
    setPosition({ top, left })
  }, [open])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [open])

  const handleKill = (entry: ProcessEntry) => {
    setRecentlyClosed((prev) =>
      [
        {
          terminalId: entry.terminalId,
          workspaceName: entry.workspaceName,
          processName: entry.processName,
          ports: entry.ports,
          closedAt: Date.now(),
        },
        ...prev,
      ].slice(0, MAX_RECENTLY_CLOSED),
    )
    window.electronAPI?.shellKillProcess?.(entry.terminalId)
  }

  const handleRestart = (item: RecentlyClosed) => {
    // Send up-arrow + enter to the terminal to re-run the last command
    // \x1b[A = up arrow (recall last command), \r = enter (execute it)
    window.electronAPI?.terminalWrite?.(item.terminalId, '\x1b[A\r')
    // Remove from recently closed
    setRecentlyClosed((prev) => prev.filter((r) => r !== item))
  }

  return (
    <>
      <button
        ref={buttonRef}
        className="relative text-muted hover:text-primary transition-colors p-1"
        title="Processes & Ports"
        onClick={() => setOpen((v) => !v)}
      >
        <Pulse size={16} />
        {portCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 bg-emerald-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center px-1">
            {portCount}
          </span>
        )}
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          data-theme="dark-warm"
          className="fixed z-[9999] rounded-md border border-subtle bg-surface-4 backdrop-blur-xl shadow-2xl overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150"
          style={{ top: position.top, left: position.left, width: 280 }}
        >
          {/* Header */}
          <div className="px-3 py-2 border-b border-subtle flex items-center justify-between">
            <span className="text-[11px] font-semibold text-primary tracking-wide">Processes & Ports</span>
            {activeProcesses.length > 0 && (
              <span className="text-[10px] text-muted">{activeProcesses.length} active</span>
            )}
          </div>

          {/* Active processes */}
          {activeProcesses.length === 0 && validRecentlyClosed.length === 0 ? (
            <div className="px-3 py-6 text-[11px] text-muted text-center">No active processes</div>
          ) : (
            <div className="max-h-80 overflow-y-auto py-1">
              {grouped.map(([wsId, { name, entries }]) => (
                <div key={wsId}>
                  <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-medium text-muted uppercase tracking-wider">
                    {name}
                  </div>
                  {entries.map((entry) => (
                    <div
                      key={entry.terminalId}
                      className="group flex items-center gap-2 mx-1 px-2 py-1.5 rounded-md hover:bg-hover"
                    >
                      <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 flex-shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-medium text-primary leading-snug truncate">
                          {entry.processName ?? 'shell'}
                        </div>
                        {entry.ports.length > 0 && (
                          <div className="flex gap-1 mt-0.5 flex-wrap">
                            {entry.ports.map((port) => (
                              <span
                                key={port}
                                className="text-[9px] bg-surface-6 text-secondary rounded px-1 py-px"
                              >
                                :{port}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <button
                        className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-red-500/20 text-muted hover:text-red-400 transition-all"
                        title="Kill process"
                        onClick={(e) => { e.stopPropagation(); handleKill(entry) }}
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ))}
                </div>
              ))}

              {/* Recently closed */}
              {validRecentlyClosed.length > 0 && (
                <>
                  <div className="mx-3 my-1 border-t border-subtle" />
                  <div className="px-3 pt-1.5 pb-0.5 text-[10px] font-medium text-muted uppercase tracking-wider">
                    Recently Closed
                  </div>
                  {validRecentlyClosed.map((item, i) => (
                    <div
                      key={`closed-${i}`}
                      className="group flex items-center gap-2 mx-1 px-2 py-1.5 rounded-md cursor-pointer hover:bg-hover opacity-60 hover:opacity-100 transition-opacity"
                      onClick={() => handleRestart(item)}
                      title="Restart — re-runs the last command in this terminal"
                    >
                      <ArrowClockwise size={10} className="text-muted group-hover:text-emerald-400 flex-shrink-0 transition-colors" />
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] text-muted leading-snug truncate">
                          {item.processName ?? 'process'}{' '}
                          <span className="text-[10px]">on {item.workspaceName}</span>
                        </div>
                        {item.ports.length > 0 && (
                          <div className="text-[9px] text-muted mt-0.5">
                            was on {item.ports.map((p) => `:${p}`).join(', ')}
                          </div>
                        )}
                      </div>
                      <span className="text-[9px] text-muted group-hover:text-secondary flex-shrink-0 transition-colors">
                        restart
                      </span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
