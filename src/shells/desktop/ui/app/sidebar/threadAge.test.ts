import { expect, it } from 'vitest'
import { threadAge } from './threadActivity'

it('formats the elapsed completion time without inventing missing history', () => {
  const now = Date.now()
  expect(threadAge(undefined, now)).toBe('–')
  expect(threadAge(now, now)).toBe('now')
  expect(threadAge(now - 59_000, now)).toBe('now')
  expect(threadAge(now - 60_000, now)).toBe('1m')
  expect(threadAge(now - 3_600_000, now)).toBe('1h')
  expect(threadAge(now - 61 * 86_400_000, now)).toBe('61d')
})
