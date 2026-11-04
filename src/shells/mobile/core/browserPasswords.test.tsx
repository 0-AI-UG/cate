import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'

// Exercise the exact script installed in the native web view, including its
// capture listeners and the last origin/target check before writing secrets.
const source = readFileSync('ios/Cate/App/BrowserPasswords.swift', 'utf8').split('static let script = #"""')[1].split('"""#')[0]
let removeListeners = () => {}
afterEach(() => removeListeners())


function setup(html = '<form><input name="email" type="email"><input name="password" type="password"><button>Log in</button></form>') {
  const listeners = vi.spyOn(document, 'addEventListener')
  removeListeners = () => {
    for (const [type, listener, options] of listeners.mock.calls) document.removeEventListener(type, listener, options)
  }
  const window = globalThis.window
  window.document.body.innerHTML = html
  const messages: Array<Record<string, string>> = []
  Object.assign(window, { webkit: { messageHandlers: { passwords: { postMessage: (message: Record<string, string>) => messages.push(message) } } } })
  window.eval(source)
  const input = (name: string) => window.document.querySelector<HTMLInputElement>(`input[name=${name}]`)!
  const focus = (name: string) => {
    input(name).focus()
    return messages.at(-1)!.target
  }
  const fill = (id: string, origin = window.location.origin) => (window as unknown as { cateFill: (id: string, origin: string, username: string, password: string) => boolean }).cateFill(id, origin, 'alice', 'secret')
  return { window, messages, input, focus, fill }
}

it('fills the selected form with input/change events and does not submit', () => {
  const t = setup()
  const events: string[] = []
  t.input('email').addEventListener('input', () => events.push('input'))
  t.input('password').addEventListener('change', () => events.push('change'))
  expect(t.fill(t.focus('password'))).toBe(true)
  expect(t.input('email').value).toBe('alice')
  expect(t.input('password').value).toBe('secret')
  expect(events).toEqual(['input', 'change'])
  expect(t.messages.some(message => message.kind === 'submit')).toBe(false)
})

it('rejects wrong origins, stale targets, and detached fields', () => {
  const t = setup()
  const target = t.focus('email')
  expect(t.fill(target, 'https://other.example')).toBe(false)
  t.focus('password')
  expect(t.fill(target)).toBe(false)
  const current = t.messages.at(-1)!.target
  t.input('password').remove()
  expect(t.fill(current)).toBe(false)
  expect(t.input('email').value).toBe('')
})

it('captures before a page submit handler clears the password', () => {
  const t = setup()
  t.input('email').value = 'alice'
  t.input('password').value = 'secret'
  const form = t.window.document.querySelector('form')!
  form.addEventListener('submit', event => { event.preventDefault(); t.input('password').value = '' })
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  expect(t.messages.at(-1)).toMatchObject({ kind: 'submit', username: 'alice', password: 'secret' })
  expect(t.input('password').value).toBe('')
})

it('captures SPA login clicks and Enter, and prefers a new account password', () => {
  const t = setup('<input name="email" type="email"><input name="password" type="password"><input name="new" type="password" autocomplete="new-password"><button type="button">Sign up</button>')
  t.input('email').value = 'alice'
  t.input('password').value = 'old'
  t.input('new').value = 'new-secret'
  t.window.document.querySelector('button')!.click()
  expect(t.messages.at(-1)).toMatchObject({ kind: 'submit', password: 'new-secret' })
  t.input('new').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  expect(t.messages.at(-1)).toMatchObject({ kind: 'submit', password: 'new-secret' })
})

it('fills only the selected form and supports username-first pages', () => {
  const t = setup('<form><input name="email" type="email"></form><form><input name="password" type="password"></form>')
  expect(t.fill(t.focus('email'))).toBe(true)
  expect(t.input('email').value).toBe('alice')
  expect(t.input('password').value).toBe('')
})
