import { describe, expect, it } from 'vitest'
import { activityForPid } from './process'
import type { ProcTree } from './procfs'

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
