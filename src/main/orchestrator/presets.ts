// =============================================================================
// Agent presets — describe how to launch each supported coding agent inside
// a recruited Cate terminal.
//
// We ship a built-in default for the common tools (Claude Code, Codex,
// Gemini CLI, opencode, Pi); the user can override or add new presets via
// ~/.cate/presets.json. On app start we run `which <command>` for each
// default and mark those that aren't on PATH as `available: false` — the
// recruit CLI surface uses this to give a clean error before spawning.
//
// Each preset declares `roleFileName` — the per-agent context file we drop
// into a recruit's cwd when a role prompt is assigned. Different tools have
// different conventions:
//   - Claude Code: CLAUDE.md   (auto-loaded as project context)
//   - Codex:       AGENTS.md   (de-facto convention used by OpenAI Codex)
//   - Gemini CLI:  GEMINI.md   (auto-loaded as session context)
//   - opencode:    AGENTS.md   (shares Codex's convention)
//   - Pi:          ROLE.md     (no native context file; we type it as the
//                              first user message and stash a copy here)
//   - shell:       (no role file — vanilla shell recruit)
// =============================================================================

import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'
import log from '../logger'

export type AgentKind = 'claude' | 'codex' | 'gemini' | 'opencode' | 'pi' | 'shell'

export interface AgentPreset {
  /** User-facing identifier (case-insensitive lookup). Examples: "Claude Code", "Codex". */
  name: string
  /** The tool's CLI binary, looked up on PATH at spawn time. */
  command: string
  /** Extra args passed after `command`. */
  args: string[]
  /** What kind of agent this is — controls role-file naming + kickoff behavior. */
  agentKind: AgentKind
  /** Name of the per-agent context file we write into `.cate/roles/<id>/`
   *  when a role prompt is assigned. Empty string = no role file. */
  roleFileName: string
  /** True if the binary is on PATH right now. Detected on app start; null
   *  until the first detection sweep finishes. */
  available?: boolean | null
  /** Optional: a message we type into the terminal AFTER the agent starts,
   *  before any role kickoff. Useful for tools that need a "/help" priming. */
  primeText?: string
  /** Optional: tells the recruit flow to skip launching the binary entirely
   *  and just present a shell. Used by the 'shell' preset. */
  bareShell?: boolean
}

// Built-in defaults. Override via ~/.cate/presets.json (see loadPresets()).
const BUILTIN_PRESETS: AgentPreset[] = [
  { name: 'Claude Code', command: 'claude',   args: [], agentKind: 'claude',   roleFileName: 'CLAUDE.md' },
  { name: 'Codex',       command: 'codex',    args: [], agentKind: 'codex',    roleFileName: 'AGENTS.md' },
  { name: 'Gemini',      command: 'gemini',   args: [], agentKind: 'gemini',   roleFileName: 'GEMINI.md' },
  { name: 'opencode',    command: 'opencode', args: [], agentKind: 'opencode', roleFileName: 'AGENTS.md' },
  // Pi is Inflection's chat product; no first-party CLI exists, so we point
  // at a common community wrapper. Users who don't have it installed simply
  // see availability: false in `cate preset list`.
  { name: 'Pi',          command: 'pi',       args: [], agentKind: 'pi',       roleFileName: 'ROLE.md' },
  // Vanilla shell — useful when the user just wants a worker terminal without
  // any agent inside it.
  { name: 'Shell',       command: '',         args: [], agentKind: 'shell',    roleFileName: '', bareShell: true },
]

let cached: AgentPreset[] | null = null

function presetsPath(): string {
  return path.join(os.homedir(), '.cate', 'presets.json')
}

async function loadOverrides(): Promise<AgentPreset[]> {
  const p = presetsPath()
  try {
    const raw = await fs.readFile(p, 'utf8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      log.warn('Presets: %s is not an array, ignoring', p)
      return []
    }
    return parsed.filter((p) => p && typeof p === 'object' && typeof p.name === 'string')
  } catch (e: any) {
    if (e?.code !== 'ENOENT') log.warn('Presets: failed to load %s: %s', p, e?.message ?? e)
    return []
  }
}

function which(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!cmd) return resolve(null)
    execFile('/usr/bin/env', ['which', cmd], { timeout: 1500 }, (err, stdout) => {
      if (err) return resolve(null)
      const found = stdout.trim().split('\n')[0]
      resolve(found || null)
    })
  })
}

/** Returns the merged preset list (overrides take precedence by name). The
 *  list is cached after first call; call refresh() to re-detect availability. */
export async function getPresets(): Promise<AgentPreset[]> {
  if (cached) return cached
  await refresh()
  return cached!
}

/** Re-read the override file and re-detect installed binaries. */
export async function refresh(): Promise<void> {
  const overrides = await loadOverrides()
  const byName = new Map<string, AgentPreset>()
  for (const p of BUILTIN_PRESETS) byName.set(p.name.toLowerCase(), { ...p })
  for (const p of overrides) byName.set(p.name.toLowerCase(), { ...byName.get(p.name.toLowerCase()), ...p })

  const merged = Array.from(byName.values())
  // Detect availability in parallel.
  await Promise.all(merged.map(async (p) => {
    if (p.bareShell) { p.available = true; return }
    const path = await which(p.command)
    p.available = path != null
  }))
  cached = merged
  log.info('Presets: refreshed (%d presets, %d available)', merged.length, merged.filter((p) => p.available).length)
}

/** Lookup by case-insensitive name match. */
export async function findPreset(name: string): Promise<AgentPreset | null> {
  const presets = await getPresets()
  const needle = name.trim().toLowerCase()
  return presets.find((p) => p.name.toLowerCase() === needle) ?? null
}

/** Return the default preset to use when the caller didn't specify --preset.
 *  We pick the first available agent preset (excluding shell). If nothing is
 *  available, fall back to shell. */
export async function defaultPreset(): Promise<AgentPreset> {
  const presets = await getPresets()
  const firstAvailable = presets.find((p) => p.available && p.agentKind !== 'shell')
  return firstAvailable ?? presets.find((p) => p.agentKind === 'shell')!
}

/** Ensure ~/.cate/presets.json exists with a stub so users can find it. */
export async function ensureOverrideStub(): Promise<void> {
  const p = presetsPath()
  if (fsSync.existsSync(p)) return
  try {
    await fs.mkdir(path.dirname(p), { recursive: true })
    const stub = `// Override or extend Cate's agent presets here. This file is a JSON array.
// Each entry looks like:
//   { "name": "My Agent", "command": "myagent", "args": [], "agentKind": "claude", "roleFileName": "CLAUDE.md" }
// agentKind ∈ "claude" | "codex" | "gemini" | "opencode" | "pi" | "shell"
// Built-in presets (Claude Code, Codex, Gemini, opencode, Pi, Shell) are merged
// with this list — entries with the same name override the built-in.
[]
`
    await fs.writeFile(p, stub, 'utf8')
  } catch {
    /* not critical; user can create it manually */
  }
}
