// =============================================================================
// recruit / dismiss handlers — spawn a new terminal panel on the caller's
// canvas, optionally apply a role prompt + per-agent context file, then type
// the agent preset's command into the PTY.
// =============================================================================

import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import log from '../../logger'
import { requireCaller, callRendererForCaller, resolveTerminalByName } from './_shared'
import { findPreset, defaultPreset, type AgentPreset, type AgentKind } from '../presets'
import { readRoleByName } from './role'
import { writePty } from '../ptyBridge'
import * as registry from '../registry'
import type { OrchRequest } from '../protocol'

export async function recruitHandle(verb: 'recruit' | 'dismiss', req: OrchRequest): Promise<any> {
  if (verb === 'recruit') return await doRecruit(req)
  return await doDismiss(req)
}

async function doRecruit(req: OrchRequest) {
  const ctx = requireCaller(req)
  const args = (req.args ?? {}) as { name?: string; preset?: string; role?: string; command?: string }
  const name = (args.name ?? '').toString().trim()
  if (!name) throw new Error('recruit requires a name')

  // Resolve the preset. If --command is provided, build an ad-hoc preset
  // around it (the user wants a custom launcher).
  let preset: AgentPreset
  if (args.command) {
    preset = { name: 'Custom', command: args.command, args: [], agentKind: 'shell', roleFileName: '', available: true }
  } else if (args.preset) {
    const found = await findPreset(args.preset)
    if (!found) throw new Error(`unknown preset "${args.preset}" — run \`cate preset list\``)
    if (!found.available) throw new Error(`preset "${found.name}" is not installed (\`${found.command}\` not on PATH)`)
    preset = found
  } else {
    preset = await defaultPreset()
    if (!preset.available && !preset.bareShell) throw new Error('no agent CLIs detected on PATH; pass --preset Shell to spawn a bare terminal')
  }

  // Materialise the role directory if a role is requested. We always create
  // .cate/roles/<recruitId>/ so that even bare shell recruits get a stable
  // cwd we can address later.
  const recruitId = randomId()
  const roleDir = path.join(os.homedir(), '.cate', 'recruits', recruitId)
  await fs.mkdir(roleDir, { recursive: true })

  let roleNameApplied: string | null = null
  if (args.role) {
    const role = await readRoleByName(args.role)
    if (!role) throw new Error(`unknown role "${args.role}" — run \`cate role list\``)
    await writeRoleFile(roleDir, preset, role.prompt)
    roleNameApplied = role.name
    // Record which role this recruit is using so `cate role assign` can find it.
    await fs.writeFile(path.join(roleDir, '.cate-role'), role.name, 'utf8')
  }

  // Ask the renderer to open a terminal panel, auto-connecting it to the
  // caller's canvas node. The renderer returns the new panelId + nodeId.
  const spawnResult = await callRendererForCaller<{ panelId: string; nodeId: string | null }>(ctx, 'openTerminalPanel', {
    name,
    cwd: roleDir,
    connectToNodeId: ctx.nodeId,
    connectToPanelId: ctx.panelId,
  })

  // Type the agent command into the new terminal. We do this only AFTER the
  // PTY has actually spawned — poll the registry for ptyId since
  // terminalCreate is async on the renderer side. Cap at ~1.5s; if the PTY
  // never reports in, we still return success and let the user type the
  // command themselves (or rerun `cate recruit`).
  let ptyId: string | null = null
  let preStartedCommand: string | null = null
  for (let i = 0; i < 60; i++) {
    await sleep(25)
    const found = registry.findByPanelId(ctx.windowId, spawnResult.panelId)
    if (found?.ptyId) { ptyId = found.ptyId; break }
  }
  if (ptyId && !preset.bareShell && preset.command) {
    const argsStr = preset.args.length > 0 ? ' ' + preset.args.map(shellQuote).join(' ') : ''
    const cmd = `${preset.command}${argsStr}`
    try {
      // Send the launch command + newline as separate writes so the shell
      // doesn't see them as a paste blob. The fresh shell hasn't enabled
      // bracketed paste yet, but this also makes us consistent with `cate
      // ask` and avoids surprises if a startup script enables it.
      writePty(ptyId, cmd)
      await sleep(20)
      writePty(ptyId, '\r')
      preStartedCommand = cmd
    } catch (e: any) {
      log.warn('Orchestrator: failed to type agent command into recruit: %s', e?.message ?? e)
    }
    if (preset.primeText) {
      try {
        await sleep(50)
        writePty(ptyId, preset.primeText)
        await sleep(20)
        writePty(ptyId, '\r')
      } catch { /* fine */ }
    }
  }

  return {
    name,
    panelId: spawnResult.panelId,
    nodeId: spawnResult.nodeId,
    preset: preset.name,
    role: roleNameApplied,
    preStartedCommand,
  }
}

async function doDismiss(req: OrchRequest) {
  const ctx = requireCaller(req)
  const args = (req.args ?? {}) as { name?: string }
  const name = (args.name ?? '').toString().trim()
  if (!name) throw new Error('dismiss requires a name')
  const target = resolveTerminalByName(ctx, name, { requireConnection: true })
  await callRendererForCaller(ctx, 'closePanel', { panelId: target.panelId })
  return { name: target.name, closed: true }
}

// -----------------------------------------------------------------------------
// Role file writing — each agent kind has its own context-file convention.
// -----------------------------------------------------------------------------

async function writeRoleFile(roleDir: string, preset: AgentPreset, prompt: string): Promise<void> {
  if (!preset.roleFileName) return
  const fmt = formatRoleBody(preset.agentKind, prompt)
  await fs.writeFile(path.join(roleDir, preset.roleFileName), fmt, 'utf8')
}

function formatRoleBody(kind: AgentKind, prompt: string): string {
  const header = `# Your role\n\nThis terminal was opened by another agent on the Cate canvas. Stay focused on the role below — it is the reason you exist on this canvas.\n\n`
  const tail = `\n\n## Working with the canvas\n\nRun \`cate list\` to see who else is connected to you. Use \`cate ask "Name" "..."\` to delegate or coordinate. Read sticky notes with \`cate note read "Name"\`. The user can also \`Alt-drag\` between panel tabs to wire new peers to you at any time.\n`
  return `${header}${prompt.trim()}${tail}`
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function randomId(): string {
  return 'r-' + Math.random().toString(36).slice(2, 10)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./=:]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}
