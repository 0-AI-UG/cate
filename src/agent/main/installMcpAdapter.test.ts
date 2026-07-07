// Coverage for the pi-mcp-adapter seeder: the pure merge (withMcpAdapter) and
// the host-aware installMcpAdapter, which reads/merges/writes the workspace's
// agent-dir settings.json through a runtime.file stub — no real fs, no pi.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'

vi.mock('electron', () => ({}))
vi.mock('../../main/logger', () => ({ default: { info: vi.fn(), warn: vi.fn() } }))

import { withMcpAdapter, installMcpAdapter, MCP_ADAPTER_PACKAGE } from './installMcpAdapter'
import type { Runtime } from '../../main/runtime/types'

describe('withMcpAdapter', () => {
  it('adds the package to empty settings', () => {
    expect(withMcpAdapter({})).toEqual({ packages: [MCP_ADAPTER_PACKAGE] })
  })

  it('appends without dropping existing packages or other keys', () => {
    const out = withMcpAdapter({ theme: 'dark', packages: ['npm:pi-skills'] })
    expect(out).toEqual({ theme: 'dark', packages: ['npm:pi-skills', MCP_ADAPTER_PACKAGE] })
  })

  it('returns null when the bare spec is already present (idempotent)', () => {
    expect(withMcpAdapter({ packages: [MCP_ADAPTER_PACKAGE] })).toBeNull()
  })

  it('treats a version-pinned spec as already present (no clobber of user pin)', () => {
    expect(withMcpAdapter({ packages: ['npm:pi-mcp-adapter@1.2.3'] })).toBeNull()
  })

  it('treats the object form as already present', () => {
    expect(withMcpAdapter({ packages: [{ source: MCP_ADAPTER_PACKAGE, skills: [] }] })).toBeNull()
  })

  it('coerces a non-array packages value rather than crashing', () => {
    // A malformed packages field is replaced with a fresh array holding the adapter.
    expect(withMcpAdapter({ packages: 'oops' as unknown as [] })).toEqual({
      packages: [MCP_ADAPTER_PACKAGE],
    })
  })
})

describe('installMcpAdapter', () => {
  beforeEach(() => vi.clearAllMocks())

  // The module-level idempotency tracker is per-process; each test uses a fresh
  // cwd so keys don't collide across cases.
  // Build the key with path.join so it matches the separators hostJoin produces
  // for the local runtime (backslashes on Windows) — a plain "/" string would
  // miss the code's lookup on Windows and make the fake FS look empty.
  const settingsPath = (cwd: string) => path.join(cwd, '.cate', 'pi-agent', 'settings.json')

  it('writes a fresh settings.json when none exists', async () => {
    const cwd = '/ws-fresh'
    const store: Record<string, string> = {}
    const runtime = {
      id: 'local',
      file: {
        readFile: vi.fn(async (p: string) => { if (!(p in store)) throw new Error('ENOENT'); return store[p] }),
        writeFile: vi.fn(async (p: string, c: string) => { store[p] = c }),
        mkdir: vi.fn(async () => {}),
      },
    } as unknown as Runtime

    await installMcpAdapter(runtime, cwd)

    const written = JSON.parse(store[settingsPath(cwd)])
    expect(written).toEqual({ packages: [MCP_ADAPTER_PACKAGE] })
  })

  it('merges into an existing settings.json, preserving user keys', async () => {
    const cwd = '/ws-merge'
    const store: Record<string, string> = {
      [settingsPath(cwd)]: JSON.stringify({ theme: 'light', packages: ['npm:pi-skills'] }),
    }
    const writeFile = vi.fn(async (p: string, c: string) => { store[p] = c })
    const runtime = {
      id: 'local',
      file: {
        readFile: vi.fn(async (p: string) => { if (!(p in store)) throw new Error('ENOENT'); return store[p] }),
        writeFile,
        mkdir: vi.fn(async () => {}),
      },
    } as unknown as Runtime

    await installMcpAdapter(runtime, cwd)

    expect(writeFile).toHaveBeenCalledTimes(1)
    expect(JSON.parse(store[settingsPath(cwd)])).toEqual({
      theme: 'light',
      packages: ['npm:pi-skills', MCP_ADAPTER_PACKAGE],
    })
  })

  it('does not rewrite when the adapter is already registered', async () => {
    const cwd = '/ws-noop'
    const store: Record<string, string> = {
      [settingsPath(cwd)]: JSON.stringify({ packages: [MCP_ADAPTER_PACKAGE] }),
    }
    const writeFile = vi.fn(async (p: string, c: string) => { store[p] = c })
    const runtime = {
      id: 'local',
      file: {
        readFile: vi.fn(async (p: string) => { if (!(p in store)) throw new Error('ENOENT'); return store[p] }),
        writeFile,
        mkdir: vi.fn(async () => {}),
      },
    } as unknown as Runtime

    await installMcpAdapter(runtime, cwd)

    expect(writeFile).not.toHaveBeenCalled()
  })

  it('leaves a corrupt settings.json untouched', async () => {
    const cwd = '/ws-corrupt'
    const store: Record<string, string> = { [settingsPath(cwd)]: '{ not json' }
    const writeFile = vi.fn(async (p: string, c: string) => { store[p] = c })
    const runtime = {
      id: 'local',
      file: {
        readFile: vi.fn(async (p: string) => { if (!(p in store)) throw new Error('ENOENT'); return store[p] }),
        writeFile,
        mkdir: vi.fn(async () => {}),
      },
    } as unknown as Runtime

    await installMcpAdapter(runtime, cwd)

    expect(writeFile).not.toHaveBeenCalled()
    expect(store[settingsPath(cwd)]).toBe('{ not json')
  })

  it('is a no-op on the second call for the same host (idempotency tracker)', async () => {
    const cwd = '/ws-tracker'
    const store: Record<string, string> = {}
    const readFile = vi.fn(async (p: string) => { if (!(p in store)) throw new Error('ENOENT'); return store[p] })
    const runtime = {
      id: 'local',
      file: {
        readFile,
        writeFile: vi.fn(async (p: string, c: string) => { store[p] = c }),
        mkdir: vi.fn(async () => {}),
      },
    } as unknown as Runtime

    await installMcpAdapter(runtime, cwd)
    await installMcpAdapter(runtime, cwd)

    // Second call short-circuits before touching the filesystem again.
    expect(readFile).toHaveBeenCalledTimes(1)
  })
})
