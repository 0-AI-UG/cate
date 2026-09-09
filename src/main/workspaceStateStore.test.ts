import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { tmpdir } from 'os'

const dirRef = { current: tmpdir() }

vi.mock('electron', () => ({
  app: { getPath: () => dirRef.current },
}))
vi.mock('./logger', () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('chokidar', () => ({ watch: () => ({ on: vi.fn(), close: vi.fn() }) }))

let counter = 0

beforeEach(() => {
  dirRef.current = path.join(tmpdir(), `cate-workspace-state-${process.pid}-${counter++}`)
  fs.mkdirSync(dirRef.current, { recursive: true })
})

afterEach(() => {
  fs.rmSync(dirRef.current, { recursive: true, force: true })
})

describe('remote workspace state', () => {
  it('loads only entries using the current runtime contract', async () => {
    const current = {
      locator: 'cate-runtime://server-1/home/user/repo',
      connection: {
        kind: 'server',
        runtimeId: 'server-1',
        host: 'example.test',
        user: 'dev',
        remotePath: '/home/user/repo',
      },
      snapshot: { version: 2, workspaceId: 'ws', workspaceName: 'repo' },
    }
    fs.writeFileSync(path.join(dirRef.current, 'remote-workspaces.json'), JSON.stringify({
      workspaces: [
        current,
        { ...current, locator: 'cate-companion://server-1/home/user/repo' },
        { ...current, connection: { kind: 'local' } },
        { ...current, snapshot: null },
      ],
    }))

    vi.resetModules()
    const { getRemoteProjects } = await import('./workspaceStateStore')
    expect(getRemoteProjects()).toEqual([current])
  })
  it('loads versioned offline sessions including detached windows', async () => {
    const current = {
      locator: 'cate-runtime://server-1/outside/repo',
      connection: { kind: 'server', runtimeId: 'server-1', host: 'example.test', remotePath: '/outside/repo' },
      cache: { version: 1, workspace: { version: 1, name: 'repo', color: '' }, session: { version: 1, panels: {}, dockWindows: [{ panels: { editor: { unsavedContent: 'latest' } } }] } },
    }
    fs.writeFileSync(path.join(dirRef.current, 'remote-workspaces.json'), JSON.stringify({ workspaces: [current, { ...current, cache: { ...current.cache, version: 99 } }] }))
    vi.resetModules()
    const { getRemoteProjects } = await import('./workspaceStateStore')
    expect(getRemoteProjects()).toEqual([current])
  })

  it('resolves cache/sidebar setters only once their JSON files are published', async () => {
    vi.resetModules()
    const { setRemoteProjects, setSidebarSession } = await import('./workspaceStateStore')
    await setRemoteProjects([])
    await setSidebarSession({ order: ['/repo'], selected: '/repo' })
    expect(JSON.parse(fs.readFileSync(path.join(dirRef.current, 'remote-workspaces.json'), 'utf8'))).toEqual({ workspaces: [] })
    expect(JSON.parse(fs.readFileSync(path.join(dirRef.current, 'sidebar.json'), 'utf8')).session.selected).toBe('/repo')
  })

})
