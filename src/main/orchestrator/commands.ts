// =============================================================================
// Command handlers — one function per `cate <verb>`. The dispatcher in
// socketServer.ts routes incoming OrchRequest envelopes here.
// =============================================================================

import log from '../logger'
import type {
  OrchRequest, OrchResponse, ListResult, CheckArgs, CheckResult, WhoamiResult,
  AskArgs, AskResult,
} from './protocol'
import * as registry from './registry'
import { tailLines } from './dataTap'
import { askTerminal } from './ask'
import { recruitHandle } from './handlers/recruit'
import { roleHandle } from './handlers/role'
import { noteHandle } from './handlers/note'
import { presetListHandle, connectHandle, disconnectHandle } from './handlers/graph'
import { layoutHandle } from './handlers/layout'

/** Phase A ships pre-graph; Phase B flips this to true via setGraphAware(). */
let graphAware = false
export function setGraphAware(v: boolean): void { graphAware = v }
export function getGraphAware(): boolean { return graphAware }

type Reply = (resp: OrchResponse) => void

export async function handleCommand(req: OrchRequest, reply: Reply): Promise<void> {
  const ok = (data: unknown) => reply({ id: req.id, ok: true, data })
  const fail = (error: string, code?: string) => reply({ id: req.id, ok: false, error, code })

  try {
    switch (req.command) {
      case 'whoami':         return ok(handleWhoami(req))
      case 'list':           return ok(handleList(req))
      case 'check':          return ok(handleCheck(req))
      case 'ask':            return await handleAsk(req, ok, fail)
      case 'help':           return ok({ message: HELP_TEXT })

      // Phase D — recruit / dismiss / graph
      case 'recruit':        return ok(await recruitHandle('recruit', req))
      case 'dismiss':        return ok(await recruitHandle('dismiss', req))
      case 'connect':        return ok(await connectHandle(req))
      case 'disconnect':     return ok(await disconnectHandle(req))
      case 'preset:list':    return ok(await presetListHandle(req))

      // Phase D — roles
      case 'role:list':      return ok(await roleHandle('list', req))
      case 'role:create':    return ok(await roleHandle('create', req))
      case 'role:edit':      return ok(await roleHandle('edit', req))
      case 'role:assign':    return ok(await roleHandle('assign', req))
      case 'role:delete':    return ok(await roleHandle('delete', req))

      // Phase D — notes
      case 'note:create':    return ok(await noteHandle('create', req))
      case 'note:read':      return ok(await noteHandle('read', req))
      case 'note:write':     return ok(await noteHandle('write', req))
      case 'note:edit':      return ok(await noteHandle('edit', req))
      case 'note:list':      return ok(await noteHandle('list', req))

      // Phase D — layout / canvas positioning
      case 'layout:info':    return ok(await layoutHandle('info', req))
      case 'layout:move':    return ok(await layoutHandle('move', req))
      case 'layout:resize':  return ok(await layoutHandle('resize', req))
      case 'layout:focus':   return ok(await layoutHandle('focus', req))
      case 'layout:zoom':    return ok(await layoutHandle('zoom', req))
      case 'layout:arrange': return ok(await layoutHandle('arrange', req))

      default:               return fail(`unknown command: ${req.command}`, 'UNKNOWN_COMMAND')
    }
  } catch (e: any) {
    log.error('Orchestrator: command %s failed: %s', req.command, e?.stack ?? e?.message ?? e)
    fail(e?.message ?? String(e), 'INTERNAL')
  }
}

function callerContext(req: OrchRequest): { windowId: number; ptyId: string } | null {
  if (!req.callerTerminalId) return null
  const found = registry.findByPtyId(req.callerTerminalId)
  if (!found) return null
  return { windowId: found.windowId, ptyId: req.callerTerminalId }
}

function handleWhoami(req: OrchRequest): WhoamiResult {
  const ctx = callerContext(req)
  if (!ctx) return { self: null }
  const found = registry.findByPtyId(ctx.ptyId)
  if (!found) return { self: null }
  return {
    self: {
      ptyId: found.entry.ptyId ?? '',
      panelId: found.entry.panelId,
      nodeId: found.entry.nodeId,
      name: found.entry.name,
      self: true,
    },
  }
}

function handleList(req: OrchRequest): ListResult {
  const ctx = callerContext(req)
  if (!ctx) return { self: null, peers: [], graphAware }
  const { self, peers } = registry.listForCaller(ctx.windowId, ctx.ptyId, { graphAware })
  return { self, peers, graphAware }
}

function handleCheck(req: OrchRequest): CheckResult {
  const args = (req.args ?? {}) as Partial<CheckArgs>
  const name = (args.name ?? '').toString()
  const lines = Math.min(Math.max(args.lines ?? 200, 1), 5000)

  const ctx = callerContext(req)
  if (!ctx) throw new Error('caller terminal is not registered with Cate')
  if (!name) throw new Error('check requires a target name')

  const target = registry.findByName(ctx.windowId, name)
  if (!target) throw new Error(`no terminal named "${name}" on this canvas`)
  if (!target.ptyId) throw new Error(`terminal "${name}" has not started its PTY yet`)

  if (!registry.isConnected(ctx.windowId, ctx.ptyId, target.ptyId, { graphAware })) {
    throw new Error(`not connected to "${name}" — connect the panels on the canvas first`)
  }

  return { name: target.name, output: tailLines(target.ptyId, lines) }
}

async function handleAsk(
  req: OrchRequest,
  ok: (data: unknown) => void,
  fail: (error: string, code?: string) => void,
): Promise<void> {
  const args = (req.args ?? {}) as Partial<AskArgs>
  const name = (args.name ?? '').toString()
  const prompt = (args.prompt ?? '').toString()
  const settlingMs = typeof args.settlingMs === 'number' ? args.settlingMs : undefined
  const maxWaitMs = typeof args.maxWaitMs === 'number' ? args.maxWaitMs : undefined

  const ctx = callerContext(req)
  if (!ctx) return fail('caller terminal is not registered with Cate', 'NO_CALLER')
  if (!name) return fail('ask requires a target name', 'BAD_ARGS')
  if (!prompt) return fail('ask requires a non-empty prompt', 'BAD_ARGS')

  const target = registry.findByName(ctx.windowId, name)
  if (!target) return fail(`no terminal named "${name}" on this canvas`, 'NO_TARGET')
  if (!target.ptyId) return fail(`terminal "${name}" has not started its PTY yet`, 'NO_PTY')
  if (!registry.isConnected(ctx.windowId, ctx.ptyId, target.ptyId, { graphAware })) {
    return fail(`not connected to "${name}" — connect the panels on the canvas first`, 'NOT_CONNECTED')
  }

  try {
    const response = await askTerminal(target.ptyId, prompt, {
      settlingMs,
      maxWaitMs,
      callerNodeId: registry.findByPtyId(ctx.ptyId)?.entry.nodeId ?? null,
      targetNodeId: target.nodeId,
    })
    const result: AskResult = { name: target.name, response }
    ok(result)
  } catch (e: any) {
    fail(e?.message ?? String(e), e?.code ?? 'ASK_FAILED')
  }
}

const HELP_TEXT = `cate — collaborate with other terminals on the Cate canvas

Commands:
  cate list                         List your terminal and all peers you're connected to.
  cate whoami                       Print your terminal's name.
  cate check "Name"                 Show recent output from another terminal.
  cate ask "Name" "prompt"          Send a prompt; block until the peer settles, then print the reply.
  cate ask "Name" --file path       Same as above, but read the prompt from a file.
  cate where "Name"                 Print a panel's canvas position and size.
  cate move "Name" X Y              Move a panel (or note) on the canvas.
  cate resize "Name" W H            Resize a panel.
  cate focus "Name" [--zoom Z]      Center the viewport on a panel.
  cate zoom LEVEL                   Set zoom level.
  cate arrange row|column|grid|circle [--names "A,B"] [--gap N] [--cols N] [--radius N]
  cate help                         Show this help.

Notes:
  - Two terminals can only talk if they're connected on the canvas (Alt-drag from a tab to wire them).
  - "Name" is the terminal's tab title. Double-click the tab to rename.
`
