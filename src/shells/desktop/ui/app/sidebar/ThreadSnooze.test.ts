import { expect, it } from 'vitest'
import { snoozeChoices } from './ThreadSnooze'

it('uses future local evening and tomorrow-morning times', () => {
  const now = new Date(2026, 10, 8, 15, 47).getTime()
  const choices = snoozeChoices(now)
  expect(choices.map((choice) => choice.label)).toEqual(['In 1 hour', 'This evening', 'In 3 hours', 'Tomorrow'])
  expect(choices[0].until).toBe(now + 3_600_000)
  expect(choices[1].until).toBe(new Date(2026, 10, 8, 18).getTime())
  expect(choices[3].until).toBe(new Date(2026, 10, 9, 9).getTime())
  const late = snoozeChoices(new Date(2026, 10, 8, 20).getTime())
  expect(late.find((choice) => choice.label === 'Tomorrow evening')).toEqual({ label: 'Tomorrow evening', until: new Date(2026, 10, 9, 18).getTime() })
  const nearEvening = snoozeChoices(new Date(2026, 10, 8, 17, 8).getTime())
  expect(nearEvening.map((choice) => choice.label)).toEqual(['This evening', 'In 1 hour', 'In 3 hours', 'Tomorrow'])
  expect(late.map((choice) => choice.until)).toEqual(late.map((choice) => choice.until).sort((a, b) => a - b))
})
