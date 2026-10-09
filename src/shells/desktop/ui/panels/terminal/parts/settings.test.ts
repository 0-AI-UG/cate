import { expect, it } from 'vitest'
import { clientSettingsTable } from '../../../../settings'
import { resolveTerminalFontFamily, resolveTerminalFontSize, terminalOptions } from './settings'

it('falls back to the default font family', () => {
  expect(resolveTerminalFontFamily('  ')).toContain('monospace')
  expect(resolveTerminalFontFamily(' Fira Code ')).toBe('Fira Code')
})

it('follows the editor font size when the terminal size is 0', () => {
  expect(resolveTerminalFontSize(0, 15)).toBe(15)
  expect(resolveTerminalFontSize(14, 15)).toBe(14)
  expect(resolveTerminalFontSize(0, Number.NaN)).toBe(13)
})

it('maps client settings to xterm options', () => {
  const options = terminalOptions({ ...clientSettingsTable.defaults, terminalOptionIsMeta: false, terminalContrast: 7 })
  expect(options).toMatchObject({ macOptionIsMeta: false, minimumContrastRatio: 7, cursorBlink: false, fontSize: 12 })
})
