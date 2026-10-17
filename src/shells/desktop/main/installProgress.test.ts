import { expect, it } from 'vitest'
import type { InstallProgressEvent } from '../contract'
import { createInstallProgress } from './installProgress'

it('sends each step at once, its figures at most every 100 ms, and the end', () => {
  const sent: InstallProgressEvent[] = []
  let t = 0
  const hub = createInstallProgress((e) => sent.push(e), () => t)
  hub.report('ssh:box', { phase: 'upload', received: 1, total: 10 })
  t = 50
  hub.report('ssh:box', { phase: 'upload', received: 5, total: 10 })
  expect(hub.snapshot()).toEqual([{ target: 'ssh:box', progress: { phase: 'upload', received: 5, total: 10 } }])
  t = 120
  hub.report('ssh:box', { phase: 'upload', received: 8, total: 10 })
  t = 130
  hub.report('ssh:box', { phase: 'install' })
  hub.report('ssh:box', null)
  hub.report('ssh:box', null)
  expect(sent.map((e) => e.progress && ('received' in e.progress ? e.progress.received : e.progress.phase))).toEqual([1, 8, 'install', null])
  expect(hub.snapshot()).toEqual([])
})
