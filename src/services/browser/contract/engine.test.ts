import { expect, it } from 'vitest'
import { browserKeyEvent, type BrowserKeyInput } from './engine'

const key = (patch: Partial<BrowserKeyInput> = {}): BrowserKeyInput => ({ type: 'keyDown', key: 'a', code: 'KeyA', keyCode: 65, meta: false, control: false, alt: false, shift: false, ...patch })
it('keeps text input and native editing commands distinct across platforms', () => {
  expect(browserKeyEvent(key(), 'darwin')).toMatchObject({ text: 'a', modifiers: 0 })
  expect(browserKeyEvent(key({ meta: true }), 'darwin')).toMatchObject({ commands: ['selectAll'], modifiers: 4 })
  expect(browserKeyEvent(key({ control: true }), 'darwin')).toMatchObject({ commands: ['moveToBeginningOfLine'] })
  expect(browserKeyEvent(key({ control: true }), 'win32')).toMatchObject({ commands: ['selectAll'] })
  expect(browserKeyEvent(key({ key: 'Enter', keyCode: 13, code: 'Enter' }), 'darwin')).toMatchObject({ text: '\r' })
})
it('preserves AltGr text and modified selections without typing shortcut letters', () => {
  expect(browserKeyEvent(key({ key: '@', control: true, alt: true, altGraph: true }), 'win32')).toMatchObject({ text: '@', modifiers: 3 })
  const select = browserKeyEvent(key({ key: 'ArrowLeft', keyCode: 37, code: 'ArrowLeft', meta: true, shift: true }), 'darwin')
  expect(select.commands).toEqual(['moveToBeginningOfLineAndModifySelection'])
  expect(select).not.toHaveProperty('text')
  const released = browserKeyEvent(key({ type: 'keyUp', meta: true }), 'darwin')
  expect(released).not.toHaveProperty('text')
  expect(released).not.toHaveProperty('commands')
})
