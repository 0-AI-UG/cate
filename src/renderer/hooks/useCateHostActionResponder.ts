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
import { getActivePanelId } from '../lib/activePanel'
import { PANEL_REGISTRY } from '../panels/registry'
import { openFileAsPanel } from '../lib/fs/fileRouting'
import { revealPanel } from '../lib/workspace/panelReveal'
import { placementForBackgroundPanel } from '../lib/workspace/canvasAccess'
import { setPendingReveal } from '../lib/editor/editorReveal'
import { closePanelWithConfirm } from '../lib/closePanelWithConfirm'
import { toAbsolutePath, pathKey } from '../../shared/pathUtils'
import { parseLocator, formatLocator } from '../../shared/runtimeLocator'
import { handleBrowserMethod } from '../lib/browser/browserDriver'
import { handleTerminalMethod } from '../lib/terminal/terminalDriver'
import { browserPanelUrl, isStartPageUrl, type PanelType, type Point } from '../../shared/types'
import type { PanelPlacement } from '../stores/appStore'

// Host-API panel creation (CLI + extensions) is always non-interactive: callers
// may add panels but must not open the placement picker, switch tabs, change
// selection/focus, or move the user's camera. An explicit { position } still
// chooses the canvas point while preserving those background semantics.
function placementFromArgs(workspaceId: string, args: Record<string, unknown>): PanelPlacement | undefined {
  const p = args.position
  if (p && typeof p === 'object' && typeof (p as Point).x === 'number' && typeof (p as Point).y === 'number') {
    return { ...placementForBackgroundPanel(workspaceId), position: p as Point }
  }
  return placementForBackgroundPanel(workspaceId)
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
//
// SECURITY: confine the resolved path to the workspace root. An extension must
// not be able to open arbitrary files on disk (e.g. /etc/hosts, ../../secrets)
// via the reverse API — neither by passing an absolute path that escapes the
// root nor by a relative path that traverses out of it. Returns null when the
// resolved path falls outside the verified root (caller rejects the request).
function resolveWorkspacePath(workspaceId: string, filePath: string): string | null {
  const rootPath = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)?.rootPath
  if (!rootPath) return null
  // A REMOTE workspace stores rootPath as a locator URI
  // (cate-runtime://<id>/<path>), but cate.workspace.get hands the extension the
  // BARE path. So an extension that round-trips workspace.get and passes back an
  // absolute path lands us here with a bare path to compare against a locator
  // root — the containment check would wrongly reject it. Normalize BOTH sides to
  // the same bare-path form (the runtime-native path) before comparing, then
  // re-attach the locator scheme on the way out so downstream open code still
  // routes to the correct runtime. Local roots have no scheme, so this is a no-op
  // for them (bareRoot === rootPath, runtimeId === 'local').
  const { runtimeId, path: bareRoot } = parseLocator(rootPath)
  // Collapse `.`/`..` segments before checking containment so a traversal like
  // `../../etc/passwd` can't slip past a naive prefix match.
  const normalized = normalizeSegments(toAbsolutePath(filePath, bareRoot))
  const rootKey = pathKey(bareRoot)
  const key = pathKey(normalized)
  if (key !== rootKey && !key.startsWith(rootKey + '/')) return null
  return formatLocator({ runtimeId, path: normalized })
}

/** Resolve `.` / `..` segments in an absolute path WITHOUT touching the fs (this
 *  runs in the renderer, where there's no Node `path`). Mirrors the slash
 *  normalization in shared/pathUtils so the result is comparable via pathKey. */
function normalizeSegments(absPath: string): string {
  const isWindows = /^[A-Za-z]:/.test(absPath) || absPath.includes('\\')
  const norm = absPath.replace(/\\/g, '/')
  const driveMatch = /^([A-Za-z]:)(.*)$/.exec(norm)
  const prefix = driveMatch ? driveMatch[1] : ''
  const body = driveMatch ? driveMatch[2] : norm
  const leadingSlash = body.startsWith('/')
  const out: string[] = []
  for (const seg of body.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { out.pop(); continue }
    out.push(seg)
  }
  const joined = prefix + (leadingSlash ? '/' : '') + out.join('/')
  return isWindows ? joined.replace(/\//g, '\\') : joined
}

export function useCateHostActionResponder(): void {
  useEffect(() => {
    return window.electronAPI.onCateHostAction(async (payload: HostActionPayload) => {
      const { requestId, workspaceId, method } = payload
      const args = asRecord(payload.args)
      const reply = (ok: boolean, extra?: { result?: unknown; error?: string }) =>
        window.electronAPI.cateHostActionReply({ requestId, ok, ...extra })

      try {
        // Browser-control surface (cate.browser.*) is executed by the browser
        // driver, which resolves the target browser panel and drives its live
        // <webview>. Delegating here keeps this switch focused on store mutations.
        if (method.startsWith('cate.browser.')) {
          const outcome = await handleBrowserMethod(workspaceId, method, args)
          return outcome.ok
            ? reply(true, outcome.result !== undefined ? { result: outcome.result } : undefined)
            : reply(false, { error: outcome.error })
        }

        // Terminal-control surface (cate.terminal.*): the terminal driver
        // resolves the target terminal panel and reads its xterm buffer /
        // writes to its PTY via the terminalRegistry.
        if (method.startsWith('cate.terminal.')) {
          const outcome = await handleTerminalMethod(workspaceId, method, args)
          return outcome.ok
            ? reply(true, outcome.result !== undefined ? { result: outcome.result } : undefined)
            : reply(false, { error: outcome.error })
        }

        switch (method) {
          case 'cate.editor.openFile': {
            const filePath = typeof args.path === 'string' ? args.path : undefined
            if (!filePath) return reply(false, { error: 'path required' })
            // Confine the target to the workspace root — reject any path that
            // escapes it (absolute or traversal).
            const resolved = resolveWorkspacePath(workspaceId, filePath)
            if (!resolved) return reply(false, { error: 'path outside workspace' })
            // Reject a nonexistent target instead of opening a healthy-looking
            // panel on it — that silence hides typos from agent callers. (This
            // verb opens existing files; it has no new-file semantics.)
            try {
              const stat = await window.electronAPI.fsStat(resolved, workspaceId)
              if (stat.isDirectory) return reply(false, { error: 'path is a directory' })
            } catch {
              return reply(false, { error: 'file-not-found' })
            }
            const newPanelId = openFileAsPanel(workspaceId, resolved, undefined, placementForBackgroundPanel(workspaceId))
            if (!newPanelId) return reply(false, { error: 'open failed' })
            // Honor an optional { line } (and column) by stashing a one-shot
            // editor reveal — the SAME path search results and terminal file
            // links use, consumed by EditorPanel once Monaco mounts.
            const line = typeof args.line === 'number' ? args.line : undefined
            if (line !== undefined) {
              const column = typeof args.column === 'number' ? args.column : undefined
              setPendingReveal(newPanelId, { line, ...(column !== undefined ? { column } : {}) })
            }
            return reply(true, { result: { panelId: newPanelId } })
          }

          case 'cate.canvas.createPanel': {
            const type = typeof args.type === 'string' ? (args.type as PanelType) : undefined
            if (!type || !PANEL_REGISTRY[type]) return reply(false, { error: 'unknown panel type' })
            const placement = placementFromArgs(workspaceId, args)
            let newPanelId: string | null
            if (type === 'extension') {
              const extId = typeof args.extensionId === 'string' ? args.extensionId : payload.extensionId
              const extPanelId = typeof args.extensionPanelId === 'string' ? args.extensionPanelId : undefined
              if (!extPanelId) return reply(false, { error: 'extensionPanelId required' })
              newPanelId = useAppStore.getState().createExtensionPanel(workspaceId, extId, extPanelId, undefined, placement)
            } else {
              let filePath: string | undefined
              if (typeof args.filePath === 'string') {
                const resolved = resolveWorkspacePath(workspaceId, args.filePath)
                if (!resolved) return reply(false, { error: 'path outside workspace' })
                filePath = resolved
              }
              newPanelId = PANEL_REGISTRY[type].create({
                workspaceId,
                placement,
                filePath,
                url: typeof args.url === 'string' ? args.url : undefined,
              })
            }
            if (!newPanelId) return reply(false, { error: 'panel creation failed' })
            return reply(true, { result: { panelId: newPanelId } })
          }

          case 'cate.panel.list': {
            // THE enumeration surface — there is no per-type list (no
            // browser.list); browser panels carry their url here instead.
            // Same single-window scope as setTitle: panels detached into other
            // windows are absent from this store and thus from this list.
            const ws = useAppStore.getState().workspaces.find((w) => w.id === workspaceId)
            const active = getActivePanelId()
            const panels = Object.values(ws?.panels ?? {}).map((p) => ({
              panelId: p.id,
              type: p.type,
              title: p.title,
              focused: p.id === active,
              // Hand back the bare runtime path, matching workspace.get.
              ...(p.filePath ? { filePath: parseLocator(p.filePath).path } : {}),
              ...(p.type === 'browser'
                ? { url: isStartPageUrl(browserPanelUrl(p)) ? '' : (browserPanelUrl(p) ?? '') }
                : {}),
            }))
            return reply(true, { result: panels })
          }

          case 'cate.panel.focus': {
            const targetPanelId = typeof args.panelId === 'string' ? args.panelId : undefined
            if (!targetPanelId) return reply(false, { error: 'panelId required' })
            const panel = useAppStore
              .getState()
              .workspaces.find((w) => w.id === workspaceId)?.panels?.[targetPanelId]
            if (!panel) return reply(false, { error: 'panel-not-in-window' })
            const revealed = await revealPanel(workspaceId, targetPanelId)
            if (!revealed) return reply(false, { error: 'panel-not-revealable' })
            return reply(true)
          }

          case 'cate.panel.close': {
            const targetPanelId = typeof args.panelId === 'string' ? args.panelId : payload.panelId
            if (!targetPanelId) return reply(false, { error: 'panelId required' })
            const panel = useAppStore
              .getState()
              .workspaces.find((w) => w.id === workspaceId)?.panels?.[targetPanelId]
            if (!panel) return reply(false, { error: 'panel-not-in-window' })
            const closed = await closePanelWithConfirm(workspaceId, targetPanelId)
            return closed ? reply(true) : reply(false, { error: 'close-cancelled' })
          }

          case 'cate.panel.setTitle': {
            const title = typeof args.title === 'string' ? args.title : undefined
            const targetPanelId = typeof args.panelId === 'string' ? args.panelId : payload.panelId
            if (!title) return reply(false, { error: 'title required' })
            // This responder mutates ONLY this window's app store. A panel that was
            // detached into a separate dock/panel window is no longer in this store,
            // so updatePanelTitle would silently no-op — don't tell the extension the
            // (non-)op succeeded. Reject instead of reporting a lie. (Full
            // cross-window routing is a larger change.)
            const panelInWindow = useAppStore
              .getState()
              .workspaces.find((w) => w.id === workspaceId)?.panels?.[targetPanelId]
            if (!panelInWindow) return reply(false, { error: 'panel-not-in-window' })
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
