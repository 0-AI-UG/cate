// =============================================================================
// useCateHostActionResponder — renderer side of the extension "reverse API".
//
// Extensions ask Cate to do things (open a file, create a panel, retitle a
// panel) through their preload's cate.* bridge. Those calls are forwarded by
// the main process to the renderer over CATE_HOST_ACTION; this hook is the
// single subscriber that executes them against the app store and replies with
// the outcome over CATE_HOST_ACTION_REPLY.
//
// Mounted once from the top-level workspace shell (MainApp). Whatever workspace
// the extension targets is honored verbatim — the payload carries workspaceId.
// =============================================================================

import { useEffect } from 'react'
import log from '../lib/logger'
import { useAppStore } from '../stores/appStore'
import { PANEL_REGISTRY } from '../panels/registry'
import { openFileAsPanel } from '../lib/fs/fileRouting'
import { revealPanel } from '../lib/workspace/panelReveal'
import { placementForActivePanel } from '../lib/workspace/canvasAccess'
import { setPendingReveal } from '../lib/editor/editorReveal'
import { toAbsolutePath } from '../../shared/pathUtils'
import type { PanelType, Point } from '../../shared/types'
import type { PanelPlacement } from '../stores/appStore'

// Reverse-API panel creation reuses the SAME placement the keyboard shortcuts
// use (Cmd+T / Cmd+N): tab into the active dock stack, pin to the active canvas,
// or fall back to the workspace's default (primary canvas) placement — honoring
// the user's placement-picker setting just like a keybind. An explicit
// { position } from the extension overrides that and lands the panel on the
// canvas at that exact point.
function placementFromArgs(args: Record<string, unknown>): PanelPlacement | undefined {
  const p = args.position
  if (p && typeof p === 'object' && typeof (p as Point).x === 'number' && typeof (p as Point).y === 'number') {
    return { target: 'canvas', position: p as Point }
  }
  return placementForActivePanel()
}

interface HostActionPayload {
  requestId: string
  workspaceId: string
  panelId: string
  extensionId: string
  method: string
  args: unknown
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

// Extensions address files by a path relative to the workspace root (e.g.
// `cate.editor.openFile('package.json')`). The panel-open path expects an
// ABSOLUTE path — a relative one creates an editor that resolves to nothing and
// renders blank. Resolve against the workspace root (no-op for an already
// absolute path) so the reverse API reuses the exact open behavior the file
// explorer gets.
function resolveWorkspacePath(workspaceId: string, filePath: string): string {
  const rootPath = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)?.rootPath
  return rootPath ? toAbsolutePath(filePath, rootPath) : filePath
}

export function useCateHostActionResponder(): void {
  useEffect(() => {
    return window.electronAPI.onCateHostAction(async (payload: HostActionPayload) => {
      const { requestId, workspaceId, method } = payload
      const args = asRecord(payload.args)
      const reply = (ok: boolean, extra?: { result?: unknown; error?: string }) =>
        window.electronAPI.cateHostActionReply({ requestId, ok, ...extra })

      try {
        switch (method) {
          case 'cate.editor.openFile': {
            // The public bridge (cateHost.ts) sends the file as `path`; accept
            // `filePath` too for callers that use the older arg name.
            const filePath =
              typeof args.path === 'string'
                ? args.path
                : typeof args.filePath === 'string'
                  ? args.filePath
                  : undefined
            if (!filePath) return reply(false, { error: 'path required' })
            // Reuse the keybind placement (active dock stack / active canvas /
            // default) so an extension-opened file lands exactly where a
            // Cmd+N-opened one would, not always pinned to the center dock.
            const newPanelId = openFileAsPanel(workspaceId, resolveWorkspacePath(workspaceId, filePath), undefined, placementForActivePanel())
            if (!newPanelId) return reply(false, { error: 'open failed' })
            // Honor an optional { line } (and column) by stashing a one-shot
            // editor reveal — the SAME path search results and terminal file
            // links use, consumed by EditorPanel once Monaco mounts.
            const line = typeof args.line === 'number' ? args.line : undefined
            if (line !== undefined) {
              const column = typeof args.column === 'number' ? args.column : undefined
              setPendingReveal(newPanelId, { line, ...(column !== undefined ? { column } : {}) })
            }
            // Reveal/focus so the editor is brought to front.
            void revealPanel(workspaceId, newPanelId).catch(() => { /* best effort */ })
            return reply(true, { result: { panelId: newPanelId } })
          }

          case 'cate.canvas.createPanel': {
            const type = typeof args.type === 'string' ? (args.type as PanelType) : undefined
            if (!type || !PANEL_REGISTRY[type]) return reply(false, { error: 'unknown panel type' })
            const placement = placementFromArgs(args)
            let newPanelId: string | null
            if (type === 'extension') {
              const extId = typeof args.extensionId === 'string' ? args.extensionId : payload.extensionId
              const extPanelId = typeof args.extensionPanelId === 'string' ? args.extensionPanelId : undefined
              if (!extPanelId) return reply(false, { error: 'extensionPanelId required' })
              newPanelId = useAppStore.getState().createExtensionPanel(workspaceId, extId, extPanelId, undefined, placement)
            } else {
              const filePath =
                typeof args.filePath === 'string' ? resolveWorkspacePath(workspaceId, args.filePath) : undefined
              newPanelId = PANEL_REGISTRY[type].create({
                workspaceId,
                placement,
                filePath,
                url: typeof args.url === 'string' ? args.url : undefined,
              })
            }
            if (!newPanelId) return reply(false, { error: 'panel creation failed' })
            void revealPanel(workspaceId, newPanelId).catch(() => { /* best effort */ })
            return reply(true, { result: { panelId: newPanelId } })
          }

          case 'cate.panel.setTitle': {
            const title = typeof args.title === 'string' ? args.title : undefined
            const targetPanelId = typeof args.panelId === 'string' ? args.panelId : payload.panelId
            if (!title) return reply(false, { error: 'title required' })
            useAppStore.getState().updatePanelTitle(workspaceId, targetPanelId, title)
            return reply(true)
          }

          default:
            return reply(false, { error: 'unsupported' })
        }
      } catch (err) {
        log.warn('[cateHost] action failed:', method, err)
        return reply(false, { error: err instanceof Error ? err.message : 'error' })
      }
    })
  }, [])
}
