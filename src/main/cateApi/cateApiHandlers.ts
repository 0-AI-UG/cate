// Cate CLI host API: permission checks, dispatch, and renderer forwarding.

import { ipcMain, app, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import log from '../logger'
import {
  cliPermissionCellByKey,
  cliPermissionDenied,
  cliPermissionForRequest,
  type CliPermissionKey,
} from '../../shared/cliPermissions'
import {
  CATE_HOST_FORWARD,
  CATE_HOST_FORWARD_REPLY,
} from '../../shared/ipc-channels'
import { codingAgentAdmission } from './codingAgentAdmission'
import { getActiveMainWindow, getWindow } from '../windowRegistry'
import {
  getWindowPanels,
  removeWindowPanel,
  subscribeWindowPanels,
  upsertWindowPanel,
} from '../windowPanels'
import { getSetting } from '../settingsFile'
import { showOsNotification } from '../ipc/notifications'
import type { PanelType, WindowPanelInfo } from '../../shared/types'
import type { CodingAgentRunStatus } from '../../shared/codingAgentRuns'

const CATE_API_VERSION = 7

const FORWARD_TIMEOUT_MS = 10_000
const CODING_AGENT_WAIT_FORWARD_TIMEOUT_MS = 65_000

export function forwardTimeoutMs(method: string): number {
  if (method === 'cate.codingAgent.wait') return CODING_AGENT_WAIT_FORWARD_TIMEOUT_MS
  return FORWARD_TIMEOUT_MS
}

/** Stable errors for CLI permission cells (Settings → CLI) that are off. Each
 *  tells the caller how to get the feature enabled, not just that it is denied.
 *  Derived from the matrix so the copy has one home. */
const deniedFor = (key: CliPermissionKey): string => cliPermissionDenied(cliPermissionCellByKey(key))
export const TERMINAL_INPUT_DISABLED = deniedFor('cliTerminalInputEnabled')
export const TERMINAL_READ_DISABLED = deniedFor('cliTerminalReadEnabled')
export const BROWSER_READ_DISABLED = deniedFor('cliBrowserReadEnabled')
export const BROWSER_CONTROL_DISABLED = deniedFor('cliBrowserControlEnabled')

interface InvokePayload {
  workspaceId: string
  panelId: string
  method: string
  args: unknown
  /** Runtime-absolute cwd of a trusted terminal/agent caller. */
  originCwd?: string
}

type InvokeResult = unknown | { error: string; method?: string }

export interface InvokeScope {
  workspaceId: string
  panelId: string | undefined
  forward: (payload: InvokePayload) => Promise<InvokeResult>
  /** Runtime-absolute cwd of an embedded supervisor session. */
  originCwd?: string
}

// ---------------------------------------------------------------------------
// Forward request/response — completes a CATE_HOST_FORWARD sent to a renderer.
// ---------------------------------------------------------------------------

const pendingForwards = new Map<
  string,
  { resolve: (r: InvokeResult) => void; timer: ReturnType<typeof setTimeout> }
>()

export function forwardToOwner(
  owner: WebContents,
  payload: InvokePayload,
): Promise<InvokeResult> {
  return new Promise<InvokeResult>((resolve) => {
    const requestId = randomUUID()
    const timer = setTimeout(() => {
      pendingForwards.delete(requestId)
      resolve({ error: 'timeout', method: payload.method })
    }, forwardTimeoutMs(payload.method))
    pendingForwards.set(requestId, { resolve, timer })
    try {
      owner.send(CATE_HOST_FORWARD, {
        requestId,
        workspaceId: payload.workspaceId,
        panelId: payload.panelId,
        method: payload.method,
        args: payload.args,
        originCwd: payload.originCwd,
      })
    } catch (err) {
      clearTimeout(timer)
      pendingForwards.delete(requestId)
      resolve({ error: 'no-owner', method: payload.method })
      log.warn('[cate-api] forward send failed: %O', err)
    }
  })
}

export function forwardToActiveWindow(payload: InvokePayload): Promise<InvokeResult> {
  const win = getActiveMainWindow()
  if (!win || win.isDestroyed()) {
    return Promise.resolve({ error: 'no-host-window', method: payload.method })
  }
  return forwardToOwner(win.webContents, payload)
}

/**
 * Resolve the webContents that should receive a cate.browser.* / cate.terminal.*
 * method: the window that OWNS the addressed panel (of the required type), or
 * the active main window when the caller doesn't address a specific panel.
 * Unlike the state-mutating forwards above, these methods must reach the exact
 * window hosting that panel's webview/xterm, not just any active window.
 */
function resolvePanelTargetWindow(
  panelId: string | undefined,
  type: 'browser' | 'terminal' | 'review',
): { wc: WebContents; ownerWindowId: number } | { error: string } {
  if (panelId) {
    const info = getWindowPanels().find((p) => p.panelId === panelId)
    if (!info || info.type !== type) return { error: `no-such-${type}` }
    const win = getWindow(info.ownerWindowId)
    if (!win || win.isDestroyed()) return { error: 'no-host-window' }
    return { wc: win.webContents, ownerWindowId: info.ownerWindowId }
  }
  const win = getActiveMainWindow()
  if (!win || win.isDestroyed()) return { error: 'no-host-window' }
  return { wc: win.webContents, ownerWindowId: win.id }
}

/** Resolve a mission worker to the renderer currently hosting its terminal.
 * Window reports carry both the run and supervisor identities, preventing one
 * terminal or embedded-agent session from using a guessed run id to reach
 * another mission. */
function resolveCodingAgentTargetWindow(
  runIds: string[],
  ownerPanelId: string,
): { wc: WebContents } | { error: string } | null {
  if (runIds.length === 0) return null
  const reports = runIds.map((runId) =>
    getWindowPanels().find((panel) =>
      panel.type === 'terminal' &&
      panel.codingAgentRunId === runId &&
      panel.codingAgentOwnerPanelId === ownerPanelId,
    ),
  )
  // A just-created panel may not have reached the debounced discovery report
  // yet. The supervisor-bound forward remains exact in that common case.
  if (reports.some((report) => !report)) return null
  const ownerIds = new Set(reports.map((report) => report!.ownerWindowId))
  if (ownerIds.size !== 1) return { error: 'coding-agent-runs-span-windows' }
  const win = getWindow([...ownerIds][0])
  if (!win || win.isDestroyed()) return { error: 'coding-agent-window-not-found' }
  return { wc: win.webContents }
}

const ACTIONABLE_CODING_AGENT_STATUSES = new Set<CodingAgentRunStatus>([
  'waiting',
  'ready',
  'stopped',
  'failed',
])

function codingAgentReports(
  runIds: string[],
  ownerPanelId: string,
): WindowPanelInfo[] | null {
  const reports = runIds.map((runId) =>
    getWindowPanels().find((panel) =>
      panel.type === 'terminal' &&
      panel.codingAgentRunId === runId &&
      panel.codingAgentOwnerPanelId === ownerPanelId,
    ),
  )
  return reports.some((report) => !report) ? null : reports as WindowPanelInfo[]
}

async function inspectCodingAgentReports(args: {
  reports: WindowPanelInfo[]
  workspaceId: string
  ownerPanelId: string
  originCwd?: string
}): Promise<unknown[]> {
  return Promise.all(args.reports.map(async (report) => {
    const win = getWindow(report.ownerWindowId)
    if (!win || win.isDestroyed()) {
      return {
        id: report.codingAgentRunId,
        panelId: report.panelId,
        status: report.codingAgentStatus,
      }
    }
    const result = await forwardToOwner(win.webContents, {
      workspaceId: args.workspaceId,
      panelId: args.ownerPanelId,
      method: 'cate.codingAgent.inspect',
      args: {
        runId: report.codingAgentRunId,
        _cateOriginCwd: args.originCwd,
      },
    })
    if (result && typeof result === 'object' && !('error' in result)) {
      const { recentOutput: _recentOutput, ...compact } =
        result as Record<string, unknown>
      return compact
    }
    return {
      id: report.codingAgentRunId,
      panelId: report.panelId,
      status: report.codingAgentStatus,
    }
  }))
}

/** Wait across workers hosted by different renderers using the existing
 * cross-window discovery events. No renderer polling and no orphaned parallel
 * wait requests: one main-process subscription observes all worker statuses. */
function waitForCrossWindowCodingAgents(args: {
  runIds: string[]
  workspaceId: string
  ownerPanelId: string
  originCwd?: string
  timeoutSeconds: unknown
  baselineStatuses?: unknown
}): Promise<InvokeResult> {
  const initial = codingAgentReports(args.runIds, args.ownerPanelId)
  if (!initial || initial.some((report) => !report.codingAgentStatus)) {
    return Promise.resolve({
      error: 'coding-agent-status-unavailable',
      method: 'cate.codingAgent.wait',
    })
  }
  const suppliedBaseline = args.baselineStatuses && typeof args.baselineStatuses === 'object'
    ? args.baselineStatuses as Record<string, unknown>
    : null
  const baseline = new Map(initial.map((report) => {
    const supplied = suppliedBaseline?.[report.codingAgentRunId!]
    return [
      report.codingAgentRunId!,
      typeof supplied === 'string' ? supplied as CodingAgentRunStatus : report.codingAgentStatus!,
    ] as const
  }))
  const requestedSeconds = Number(args.timeoutSeconds ?? 10)
  const timeoutMs = (Number.isFinite(requestedSeconds)
    ? Math.max(5, Math.min(60, requestedSeconds))
    : 10) * 1_000

  return new Promise((resolve) => {
    let settled = false
    let unsubscribe = () => {}
    const finish = async (
      timedOut: boolean,
      changedRunIds: string[],
      reports: WindowPanelInfo[],
    ): Promise<void> => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve({
        timedOut,
        changedRunIds,
        runs: await inspectCodingAgentReports({ reports, ...args }),
      })
    }
    const check = (): void => {
      const reports = codingAgentReports(args.runIds, args.ownerPanelId)
      if (!reports) {
        void finish(false, args.runIds, initial)
        return
      }
      const changedRunIds = reports
        .filter((report) =>
          report.codingAgentStatus !== baseline.get(report.codingAgentRunId!) &&
          report.codingAgentStatus !== undefined &&
          ACTIONABLE_CODING_AGENT_STATUSES.has(report.codingAgentStatus),
        )
        .map((report) => report.codingAgentRunId!)
      for (const report of reports) {
        if (report.codingAgentStatus) baseline.set(report.codingAgentRunId!, report.codingAgentStatus)
      }
      if (changedRunIds.length > 0) void finish(false, changedRunIds, reports)
    }
    const initialActionable = suppliedBaseline ? [] : initial
      .filter((report) => ACTIONABLE_CODING_AGENT_STATUSES.has(report.codingAgentStatus!))
      .map((report) => report.codingAgentRunId!)
    const timer = setTimeout(() => {
      const reports = codingAgentReports(args.runIds, args.ownerPanelId) ?? initial
      void finish(true, [], reports)
    }, timeoutMs)
    unsubscribe = subscribeWindowPanels(check)
    if (initialActionable.length > 0) {
      void finish(false, initialActionable, initial)
      return
    }
    check()
  })
}

// ---------------------------------------------------------------------------
// Method dispatch
// ---------------------------------------------------------------------------

const FORWARDED_METHODS = new Set([
  'editor.openFile',
  'canvas.createPanel',
])

function unsupported(method: string): InvokeResult {
  return { error: 'unsupported', method }
}

/** Check the CLI master switch and per-capability permissions without
 * dispatching. Endpoint-local methods use this before touching their state. */
export function authorizeCateInvoke(
  method: string,
  args: unknown,
): InvokeResult | null {
  // CLI calls must never move the user's focus or canvas camera.
  if (method === 'cate.panel.focus') return unsupported(method)

  if (getSetting('cliEnabled') !== true) {
    return {
      error: 'cli-disabled: enable Command-line control (cate CLI) in Cate Settings → CLI',
      method,
    }
  }
  const cell = cliPermissionForRequest(method, args)
  if (cell && getSetting(cell.key) !== true) {
    return { error: cliPermissionDenied(cell), method }
  }

  return null
}

export async function dispatchCateInvoke(
  scope: InvokeScope,
  method: string,
  args: unknown,
): Promise<InvokeResult> {
  const denied = authorizeCateInvoke(method, args)
  if (denied) return denied

  const { workspaceId, panelId } = scope

  if (method.startsWith('cate.codingAgent.')) {
    const routedArgs: Record<string, unknown> = {
      ...((args ?? {}) as Record<string, unknown>),
      _cateOriginCwd: scope.originCwd,
    }
    const name = method.slice('cate.codingAgent.'.length)
    const requestedRunIds = name === 'wait'
      ? (Array.isArray(routedArgs.runIds)
          ? routedArgs.runIds.filter((id: unknown): id is string => typeof id === 'string')
          : [])
      : typeof routedArgs.runId === 'string' ? [routedArgs.runId] : []
    const target = name === 'create'
      ? typeof routedArgs.terminalPanelId === 'string'
        ? resolvePanelTargetWindow(routedArgs.terminalPanelId, 'terminal')
        : null
      : resolveCodingAgentTargetWindow(requestedRunIds, panelId ?? '')
    if (target && 'error' in target) {
      if (name === 'wait' && target.error === 'coding-agent-runs-span-windows') {
        return waitForCrossWindowCodingAgents({
          runIds: requestedRunIds,
          workspaceId,
          ownerPanelId: panelId ?? '',
          originCwd: scope.originCwd,
          timeoutSeconds: routedArgs.timeoutSeconds,
          baselineStatuses: routedArgs.baselineStatuses,
        })
      }
      return { error: target.error, method }
    }
    const payload = {
      workspaceId,
      panelId: panelId ?? '',
      method,
      args: routedArgs,
    }
    const forward = (): Promise<InvokeResult> => target
      ? forwardToOwner(target.wc, payload)
      : scope.forward(payload)
    if (name === 'list') {
      const local = await forward()
      if (local && typeof local === 'object' && 'error' in local) return local
      const runs = Array.isArray(local) ? [...local] : []
      const seen = new Set(runs.flatMap((run) => {
        const id = run && typeof run === 'object' ? (run as Record<string, unknown>).id : undefined
        return typeof id === 'string' ? [id] : []
      }))
      const reports = getWindowPanels().filter((report) =>
        report.workspaceId === workspaceId &&
        report.type === 'terminal' &&
        report.codingAgentOwnerPanelId === (panelId ?? '') &&
        typeof report.codingAgentRunId === 'string' &&
        !seen.has(report.codingAgentRunId),
      )
      const remote = await inspectCodingAgentReports({
        reports,
        workspaceId,
        ownerPanelId: panelId ?? '',
        originCwd: scope.originCwd,
      })
      return [...runs, ...remote]
    }
    if (name === 'create') {
      const admission = await codingAgentAdmission.admit({
        workspaceId,
        ownerPanelId: panelId ?? '',
        panels: getWindowPanels,
        create: forward,
      })
      return admission.admitted
        ? admission.result
        : { error: 'coding-agent-limit', method }
    }
    return forward()
  }

  if (method.startsWith('cate.review.')) {
    const routedArgs = (args ?? {}) as Record<string, unknown>
    const target = resolvePanelTargetWindow(
      typeof routedArgs.panelId === 'string' ? routedArgs.panelId : undefined,
      'review',
    )
    if ('error' in target) return { error: target.error, method }
    return forwardToOwner(target.wc, {
      workspaceId,
      panelId: panelId ?? '',
      method,
      args: routedArgs,
    })
  }

  // Browser control: route to the OWNER window of the addressed browser panel
  // (args.panelId), or the active main window when unaddressed. `panelId` on the
  // forwarded payload stays the caller's own origin panel (empty for terminals).
  if (method.startsWith('cate.browser.')) {
    const a = (args ?? {}) as { panelId?: string }
    const target = resolvePanelTargetWindow(typeof a.panelId === 'string' ? a.panelId : undefined, 'browser')
    if ('error' in target) return { error: target.error, method }
    const result = await forwardToOwner(target.wc, { workspaceId, panelId: panelId ?? '', method, args })
    if (method === 'cate.browser.open' && !a.panelId && result && typeof result === 'object') {
      const opened = result as { panelId?: unknown; url?: unknown }
      if (typeof opened.panelId === 'string') {
        upsertWindowPanel(target.ownerWindowId, {
          panelId: opened.panelId,
          type: 'browser',
          title: typeof opened.url === 'string' ? opened.url : 'Browser',
          workspaceId,
          url: typeof opened.url === 'string' ? opened.url : '',
          focused: false,
        })
      }
    }
    return result
  }

  // Terminal control: route to the OWNER window of the addressed terminal panel
  // (args.panelId), or the active main window when unaddressed (`read` resolves
  // the focused terminal renderer-side). Both halves are permission cells
  // (Settings → CLI), checked above: Read (on by default — scrollback may hold
  // printed secrets) and Control (OFF by default — keystrokes into a live shell).
  if (method.startsWith('cate.terminal.')) {
    const a = (args ?? {}) as { panelId?: string }
    const target = resolvePanelTargetWindow(typeof a.panelId === 'string' ? a.panelId : undefined, 'terminal')
    if ('error' in target) return { error: target.error, method }
    return forwardToOwner(target.wc, { workspaceId, panelId: panelId ?? '', method, args })
  }

  switch (method) {
    case 'cate.version':
      return CATE_API_VERSION

    case 'cate.ui.notify': {
      const a = (args ?? {}) as { message?: string; level?: string }
      const message = typeof a.message === 'string' ? a.message : ''
      if (message && getSetting('notificationsEnabled')) {
        try {
          showOsNotification({ title: 'Cate', body: message })
        } catch { /* best effort */ }
      }
      log.info('[cate-api] %s notify (%s): %s', workspaceId, a.level ?? 'info', message)
      return { ok: true }
    }

    case 'cate.panel.list': {
      // Read the active renderer synchronously so a just-created panel is
      // visible before the 200ms cross-window discovery report lands, then add
      // panels owned by detached/other windows from main's authoritative union.
      const local = await scope.forward({ workspaceId, panelId: panelId ?? '', method, args })
      if (!Array.isArray(local)) return local
      const rows = [...local] as Array<Record<string, unknown>>
      const seen = new Set(rows.map((row) => row.panelId).filter((id): id is string => typeof id === 'string'))
      for (const panel of getWindowPanels()) {
        if (panel.workspaceId !== workspaceId || seen.has(panel.panelId)) continue
        rows.push({
          panelId: panel.panelId,
          type: panel.type,
          title: panel.title,
          focused: panel.focused === true,
          ...(panel.filePath ? { filePath: panel.filePath } : {}),
          ...(panel.type === 'browser' ? { url: panel.url ?? '' } : {}),
        })
        seen.add(panel.panelId)
      }
      return rows
    }

    case 'cate.panel.setTitle':
    case 'cate.panel.close': {
      const a = (args ?? {}) as { panelId?: unknown }
      const targetPanelId = typeof a.panelId === 'string' && a.panelId ? a.panelId : panelId ?? ''
      if (!targetPanelId) return { error: 'bad-args', method }
      const routedArgs = { ...((args ?? {}) as Record<string, unknown>), panelId: targetPanelId }
      const owner = getWindowPanels().find((p) => p.panelId === targetPanelId && p.workspaceId === workspaceId)
      const win = owner ? getWindow(owner.ownerWindowId) : undefined
      const result = await (win && !win.isDestroyed()
        ? forwardToOwner(win.webContents, {
            workspaceId,
            panelId: panelId ?? '',
            method,
            args: routedArgs,
          })
        // Same fresh-panel race as list/focus: try the active workspace renderer.
        : scope.forward({ workspaceId, panelId: panelId ?? '', method, args: routedArgs }))
      // Evict a successfully closed panel from the cross-window union right
      // away — the owner's debounced report would otherwise keep serving the
      // stale row to panel.list, so a close-then-verify caller reads the panel
      // as still open (the eviction mirror of upsertWindowPanel on create).
      if (method === 'cate.panel.close' && !(result && typeof result === 'object' && 'error' in result)) {
        removeWindowPanel(targetPanelId)
      }
      return result
    }

    default:
      // Forward state-mutating methods (strip the leading `cate.`) to the owner.
      if (FORWARDED_METHODS.has(method.replace(/^cate\./, ''))) {
        const result = await scope.forward({
          workspaceId,
          panelId: panelId ?? '',
          method,
          args,
          originCwd: scope.originCwd,
        })
        // A create result is meant to be used immediately by the next CLI
        // command. The renderer's full panel report is debounced, so register a
        // provisional row now; otherwise `panel create browser` followed by
        // `browser open --panel <returned-id>` (and the terminal equivalent)
        // races the owner lookup and returns no-such-browser/terminal. The next
        // normal report replaces this row with the complete panel metadata.
        if (method === 'cate.canvas.createPanel' && result && typeof result === 'object') {
          const created = result as { panelId?: unknown }
          const a = (args ?? {}) as { type?: unknown; url?: unknown }
          const win = getActiveMainWindow()
          if (
            typeof created.panelId === 'string' &&
            typeof a.type === 'string' &&
            win && !win.isDestroyed()
          ) {
            upsertWindowPanel(win.id, {
              panelId: created.panelId,
              type: a.type as PanelType,
              title: typeof a.url === 'string' ? a.url : a.type,
              workspaceId,
              ...(a.type === 'browser' && typeof a.url === 'string' ? { url: a.url } : {}),
              focused: false,
            })
          }
        }
        return result
      }
      return unsupported(method)
  }
}

export function registerCateApiHandlers(): void {
  // --- Forward reply (renderer -> main) ------------------------------------
  ipcMain.on(
    CATE_HOST_FORWARD_REPLY,
    (_event, payload: { requestId: string; ok: boolean; result?: unknown; error?: string }) => {
      const pending = pendingForwards.get(payload?.requestId)
      if (!pending) return
      clearTimeout(pending.timer)
      pendingForwards.delete(payload.requestId)
      pending.resolve(payload.ok ? payload.result : { error: payload.error ?? 'forward-failed' })
    },
  )

  // Drop pending forwards / subscriptions on quit so timers don't keep the
  // event loop alive.
  app.on('will-quit', () => {
    for (const { timer } of pendingForwards.values()) clearTimeout(timer)
    pendingForwards.clear()
  })
}
