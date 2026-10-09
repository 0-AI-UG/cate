import { describe, expect, it } from 'vitest'
import { activityForPid, descendantsOf, parsePsTable, type ProcTree } from './procScan'

function tree(entries: Array<[pid: number, ppid: number, name: string]>): ProcTree {
  const nameByPid = new Map<number, string>()
  const childrenByPid = new Map<number, number[]>()
  for (const [pid, ppid, name] of entries) {
    nameByPid.set(pid, name)
    const children = childrenByPid.get(ppid)
    if (children) children.push(pid)
    else childrenByPid.set(ppid, [pid])
  }
  return { nameByPid, childrenByPid }
}

describe('terminal process activity', () => {
  it('reports the direct foreground launcher without inferring agent identity', () => {
    const processes = tree([
      [10, 1, 'zsh'],
      [20, 10, 'npm exec grok'],
      [30, 20, 'node'],
      [40, 30, 'grok-0.1.2'],
    ])

    expect(activityForPid(10, processes)).toEqual({ type: 'running', processName: 'npm exec grok' })
  })

  it('does not treat an application\'s agent probes as terminal agents', () => {
    const processes = tree([
      [10, 1, 'zsh'],
      [20, 10, 'npm run dev'],
      [30, 20, 'node'],
      [40, 30, 'Electron'],
      [50, 40, 'claude'],
      [60, 40, 'codex'],
      [70, 40, 'opencode'],
    ])

    expect(activityForPid(10, processes)).toEqual({ type: 'running', processName: 'npm run dev' })
  })

  it('reports a directly launched agent as generic terminal activity', () => {
    const processes = tree([
      [10, 1, 'zsh'],
      [20, 10, 'codex'],
    ])

    expect(activityForPid(10, processes)).toEqual({ type: 'running', processName: 'codex' })
  })
})

describe('process table', () => {
  it('parses ps output, keeping basenames and names with spaces', () => {
    const parsed = parsePsTable('  1     0 /sbin/launchd\n 10     1 /bin/zsh\n 20    10 npm run dev\n')
    expect(parsed.nameByPid.get(1)).toBe('launchd')
    expect(parsed.nameByPid.get(20)).toBe('npm run dev')
    expect(parsed.childrenByPid.get(10)).toEqual([20])
  })

  it('walks every descendant', () => {
    const processes = tree([[10, 1, 'zsh'], [20, 10, 'node'], [30, 20, 'esbuild'], [40, 1, 'other']])
    expect(descendantsOf(10, processes).sort()).toEqual([20, 30])
  })
})
