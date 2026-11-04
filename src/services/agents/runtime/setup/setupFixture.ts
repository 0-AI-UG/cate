import { vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createAgentSetup, type AgentSetupDeps } from './service'
import type { LaunchResolver, EnvContributor, ExitObserver } from '@services/terminal/runtime'

export async function createSetupFixture(overrides: Partial<AgentSetupDeps> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cate-setup-'))
  const launch = new Map<string, LaunchResolver>()
  const contributors = new Set<EnvContributor>()
  const exits = new Set<ExitObserver>()
  const probe = vi.fn(async (_command: string, args: readonly string[]) => ({ code: 0, stdout: args[0] === '--version' ? '1.4.0' : '{"loggedIn":false}' }))
  const deps: AgentSetupDeps = {
    root, agentsDir: path.join(root, 'agents'), env: () => ({}), trust: { requireTrusted() {}, isTrusted: () => true },
    probe,
    start: { terminals: { create: vi.fn(async (p) => { const resolver = launch.get(p.launch.kind)!; await resolver(p.launch.params, { cwd: root, panelId: 'setup-panel' }); for (const contribute of contributors) await contribute({ terminalId: 'pty', panelId: 'setup-panel', cwd: root, launch: p.launch, executable: 'tool', args: [], env: {} }); return 'setup-panel' }), relaunch: vi.fn(), state: () => null }, worktrees: { create: vi.fn(), remove: vi.fn() } },
    terminal: { registerLaunchIntent: (kind, resolver) => { launch.set(kind, resolver); return () => { launch.delete(kind) } }, registerEnvContributor: (c) => { contributors.add(c); return () => { contributors.delete(c) } }, onExit: (cb) => { exits.add(cb); return () => { exits.delete(cb) } }, onInput: () => () => {}, onOutput: () => () => {}, onActivity: () => () => {}, write: vi.fn(), cwd: vi.fn(), read: vi.fn(), statuses: vi.fn() },
    ...overrides,
  }
  const setup = createAgentSetup(deps)
  return { root, deps, setup, exits, probe, launch, contributors, close: async () => { setup.dispose(); await rm(root, { recursive: true, force: true }) } }
}

