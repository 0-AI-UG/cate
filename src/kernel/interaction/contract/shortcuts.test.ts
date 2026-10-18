import { describe, expect, it } from 'vitest'
import { shortcutMatches, storedShortcut } from './shortcuts'

const press = (over: object) => ({ key: '', metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, ...over })
const alt1 = storedShortcut('1', { option: true })

describe('shortcutMatches', () => {
  it('matches Option+digit by the physical key, not the typed character', () => {
    expect(shortcutMatches(press({ key: '¡', code: 'Digit1', altKey: true }), alt1)).toBe(true)
  })
  it('still matches by key when no code is given', () => {
    expect(shortcutMatches(press({ key: '1', altKey: true }), alt1)).toBe(true)
  })
  it('leaves AltGr (Ctrl+Alt) typing alone', () => {
    expect(shortcutMatches(press({ key: '{', code: 'Digit7', altKey: true, ctrlKey: true }), storedShortcut('7', { option: true }), false)).toBe(false)
  })
  it('ignores the code without Alt', () => {
    expect(shortcutMatches(press({ key: '1', code: 'Digit1' }), alt1)).toBe(false)
  })
})
