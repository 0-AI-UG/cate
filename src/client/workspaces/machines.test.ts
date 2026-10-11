import { describe, expect, it } from 'vitest'
import { groupByMachine, machineOf } from './machines'
import type { WorkspaceEntry } from './workspaceList'

const local = (root: string): WorkspaceEntry => ({ kind: 'local', id: `local:${root}`, root, name: root, lastOpenedAt: 0 })
const ssh = (destination: string, root: string): WorkspaceEntry => ({
  kind: 'machine', id: `machine:${destination}:${root}`, machine: { kind: 'ssh', target: { destination } }, root, name: root, lastOpenedAt: 0,
})
const paired = (runtimeId: string, machineName?: string): WorkspaceEntry => ({
  kind: 'paired', id: `paired:${runtimeId}`, runtimeId, name: runtimeId, endpoints: [], pairedAt: 0, lastOpenedAt: null, ...(machineName ? { machineName } : {}),
})

describe('groupByMachine', () => {
  it('groups by machine in the order each first appears', () => {
    const groups = groupByMachine([ssh('box', '/a'), local('/x'), paired('R1', 'studio'), ssh('box', '/b'), local('/y'), paired('R2', 'studio')])
    expect(groups.map((g) => [g.machine.key, g.entries.map((e) => e.id)])).toEqual([
      ['machine:ssh:ssh box', ['machine:box:/a', 'machine:box:/b']],
      ['this', ['local:/x', 'local:/y']],
      ['paired:studio', ['paired:R1', 'paired:R2']],
    ])
  })

  it('keeps paired workspaces of an unknown machine together', () => {
    expect(groupByMachine([paired('R1'), paired('R2', 'studio'), paired('R3')]).map((g) => g.entries.length)).toEqual([2, 1])
  })
})

describe('machineOf', () => {
  it('names SSH and WSL machines, and paired ones by their reported name', () => {
    expect(machineOf(ssh('box', '/a'))).toMatchObject({ kind: 'machine', label: 'box' })
    expect(machineOf({ ...ssh('x', '/a'), machine: { kind: 'wsl', distro: 'Ubuntu' } } as WorkspaceEntry)).toMatchObject({ kind: 'machine', label: 'WSL: Ubuntu' })
    expect(machineOf(paired('R', 'studio'))).toEqual({ key: 'paired:studio', kind: 'paired', label: 'studio' })
    expect(machineOf(paired('R'))).toEqual({ key: 'paired:', kind: 'paired', label: null })
  })
})
