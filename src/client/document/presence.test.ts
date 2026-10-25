import { expect, it } from 'vitest'
import type { PresenceReport } from '@workspace/document/contract'
import { createClientStateStore } from './clientState'
import { ACTIVITY_REPORT_MS, noteClientActivity, reportPresence } from './presence'

it('reports input as activity at most once per interval', async () => {
  const reports: PresenceReport[] = []
  const stop = reportPresence(createClientStateStore(), {
    report: async (params) => { reports.push(params) },
    onReady: () => () => {},
  })
  await Promise.resolve()
  reports.length = 0

  const start = 10 * ACTIVITY_REPORT_MS
  noteClientActivity(start)
  noteClientActivity(start + ACTIVITY_REPORT_MS - 1)
  expect(reports).toEqual([{ active: true }])
  noteClientActivity(start + ACTIVITY_REPORT_MS)
  expect(reports).toEqual([{ active: true }, { active: true }])

  stop()
  noteClientActivity(start + 3 * ACTIVITY_REPORT_MS)
  expect(reports).toHaveLength(2)
})
