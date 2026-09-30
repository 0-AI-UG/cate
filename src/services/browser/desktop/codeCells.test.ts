import { expect, it } from 'vitest'
import { CodeCellRegistry } from './codeCells'

it('rejects ended and expired cells, passes calls outside a cell and unknown cells', () => {
  let now = 1_000
  const cells = new CodeCellRegistry(() => now)
  cells.begin('a', 2_000)
  expect(() => cells.assert('a')).not.toThrow()
  expect(() => cells.assert(undefined)).not.toThrow()
  expect(() => cells.assert('other-client-cell')).not.toThrow()
  expect(() => cells.assert(42)).toThrow('browser-code-cell-cancelled')
  now = 2_000
  expect(() => cells.assert('a')).toThrow('browser-code-cell-cancelled')
  cells.begin('b', 5_000)
  cells.end('b')
  expect(() => cells.assert('b')).toThrow('browser-code-cell-cancelled')
})
