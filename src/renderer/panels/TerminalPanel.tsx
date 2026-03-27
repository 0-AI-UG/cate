// =============================================================================
// TerminalPanel — thin wrapper around terminalRegistry
//
// Responsibilities:
//   - Call terminalRegistry.getOrCreate() on mount to ensure the terminal and
//     PTY exist (idempotent — returns existing entry if already live).
//   - Call terminalRegistry.attach() to move the xterm DOM into this container.
//   - Own a ResizeObserver that calls fitAddon.fit() whenever the container
//     changes size.
//   - Call terminalRegistry.detach() on unmount — does NOT kill the PTY or
//     dispose anything; the terminal stays live in the registry.
// =============================================================================

import { useEffect, useRef } from 'react'
import '@xterm/xterm/css/xterm.css'

import type { TerminalPanelProps } from './types'
import { terminalRegistry } from '../lib/terminalRegistry'
import { useAppStore } from '../stores/appStore'

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TerminalPanel({
  panelId,
  workspaceId,
  nodeId,
  initialInput,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const resizeObserverRef = useRef<ResizeObserver | null>(null)

  const rootPath = useAppStore((state) =>
    state.workspaces.find((w) => w.id === workspaceId)?.rootPath,
  )

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let cancelled = false

    // 1. Ensure the terminal + PTY exist in the registry (no-op if already live)
    terminalRegistry
      .getOrCreate(panelId, {
        workspaceId,
        cwd: rootPath || undefined,
        initialInput,
      })
      .then((entry) => {
        if (cancelled) return

        // 2. Move the xterm DOM element into this container and fit it
        terminalRegistry.attach(panelId, container)

        // 3. ResizeObserver — keep xterm sized to the container
        const resizeObserver = new ResizeObserver(() => {
          try {
            entry.fitAddon.fit()
          } catch {
            // Ignore fit errors during rapid resizing or zero-size frames
          }
        })
        resizeObserver.observe(container)
        resizeObserverRef.current = resizeObserver
      })
      .catch(() => {
        // getOrCreate writes its own error message into the terminal; nothing
        // to do here.
      })

    // Cleanup on unmount: detach DOM, disconnect observer — do NOT kill PTY
    return () => {
      cancelled = true

      terminalRegistry.detach(panelId)

      if (resizeObserverRef.current) {
        resizeObserverRef.current.disconnect()
        resizeObserverRef.current = null
      }
    }
  }, [panelId, workspaceId, nodeId, initialInput, rootPath])

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{ padding: 0, overflow: 'hidden' }}
    />
  )
}
