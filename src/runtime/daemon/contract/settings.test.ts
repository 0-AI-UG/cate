import { expect, it } from 'vitest'
import { closeChoiceOf, closeChoiceTriggers } from './settings'

it('maps keepRunningWhile onto a close choice, regardless of order', () => {
  expect(closeChoiceOf(['clients', 'commands', 'agents'])).toBe('finish')
  expect(closeChoiceOf(['agents', 'clients'])).toBe('finish')
  expect(closeChoiceOf(['always'])).toBe('always')
  expect(closeChoiceOf(['agents', 'always'])).toBe('always')
  expect(closeChoiceOf(['clients'])).toBe('stop')
  expect(closeChoiceOf([])).toBe('custom')
  expect(closeChoiceOf(['commands'])).toBe('custom')
})

it('every choice keeps clients but always, which holds anyway', () => {
  expect(closeChoiceTriggers('finish')).toEqual(['agents', 'commands', 'clients'])
  expect(closeChoiceTriggers('finish', false)).toEqual(['agents', 'clients'])
  expect(closeChoiceTriggers('stop')).toEqual(['clients'])
  expect(closeChoiceTriggers('always')).toEqual(['always'])
})
