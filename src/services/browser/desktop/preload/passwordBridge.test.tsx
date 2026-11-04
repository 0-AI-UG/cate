import { afterEach, expect, it, vi } from 'vitest'
import { installPasswordBridge } from './passwordBridge'

let cleanup: (() => void) | undefined
afterEach(() => { cleanup?.(); document.body.innerHTML = '' })

it('offers username-first autofill and ignores ordinary text fields', () => {
  const send = vi.fn()
  cleanup = installPasswordBridge(send, () => false)
  document.body.innerHTML = '<input id="username" autocomplete="username"><input id="search">'
  document.querySelector<HTMLInputElement>('#username')!.focus()
  expect(send).toHaveBeenLastCalledWith('cate-browser-password-focus', expect.objectContaining({ targetId: expect.any(String) }))
  document.querySelector<HTMLInputElement>('#search')!.focus()
  expect(send).toHaveBeenLastCalledWith('cate-browser-password-focus', { dismiss: true })
})

it('captures a formless SPA login before its click handler removes the fields', () => {
  const send = vi.fn()
  cleanup = installPasswordBridge(send, () => true)
  document.body.innerHTML = '<input type="email" value="me@example.com"><input type="password" value="secret"><button type="button">Sign in</button>'
  const button = document.querySelector('button')!
  button.addEventListener('click', () => { document.body.innerHTML = '' })
  button.click()
  expect(send).toHaveBeenCalledWith('cate-browser-password-submit', expect.objectContaining({ username: 'me@example.com', password: 'secret', automated: true }))
})

it('remembers a username across SPA steps and captures Enter submission', () => {
  const send = vi.fn()
  cleanup = installPasswordBridge(send, () => false)
  document.body.innerHTML = '<input autocomplete="username" value="person"><button type="button">Continue</button>'
  document.querySelector('button')!.click()
  expect(send).not.toHaveBeenCalled()
  document.body.innerHTML = '<input type="password" value="secret">'
  document.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  expect(send).toHaveBeenCalledWith('cate-browser-password-submit', expect.objectContaining({ username: 'person', password: 'secret' }))
})

it('captures native form submissions and prefers the replacement password', () => {
  const send = vi.fn()
  cleanup = installPasswordBridge(send, () => false)
  document.body.innerHTML = '<form><input autocomplete="username" value="me"><input type="password" autocomplete="current-password" value="old"><input type="password" autocomplete="new-password" value="new"></form>'
  document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  expect(send).toHaveBeenCalledWith('cate-browser-password-submit', expect.objectContaining({ username: 'me', password: 'new' }))
})
