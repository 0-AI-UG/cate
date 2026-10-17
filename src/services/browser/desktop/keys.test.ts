import { expect, it } from 'vitest'
import { parseKey } from './keys'

it('types text keys, shifts US punctuation and leaves shortcuts without text', () => {
  expect(parseKey('Enter', 'linux')).toEqual({ events: [
    { type: 'keyDown', keyCode: 'Enter', modifiers: [] }, { type: 'char', keyCode: 'Enter', modifiers: [] }, { type: 'keyUp', keyCode: 'Enter', modifiers: [] },
  ] })
  expect(parseKey('Shift+1', 'linux')).toMatchObject({ events: [{}, { type: 'char', keyCode: '!' }, {}] })
  expect(parseKey('Ctrl+a', 'linux')).toEqual({ events: [{ type: 'keyDown', keyCode: 'a', modifiers: ['control'] }, { type: 'keyUp', keyCode: 'a', modifiers: ['control'] }] })
})

it('runs macOS editing shortcuts as commands and scrolls a page for PageDown alone', () => {
  expect(parseKey('cmd+a', 'darwin')).toMatchObject({ command: 'selectAll' })
  expect(parseKey('Meta+a', 'linux')).not.toHaveProperty('command')
  expect(parseKey('PageDown')).toEqual({ scrollPage: 1 })
  expect(parseKey('Shift+PageUp')).toHaveProperty('events')
})

it('names what it does not know', () => {
  expect(() => parseKey('Hyper+a')).toThrow('unsupported-key-modifier:Hyper')
  expect(() => parseKey('F13')).toThrow('unsupported-key:F13')
})
