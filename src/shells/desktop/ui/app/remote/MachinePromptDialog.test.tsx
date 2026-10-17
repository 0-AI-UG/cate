import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { installDesktopPort, type DesktopPort, type MachinePrompt } from '../desktop'
import { MachinePromptDialog } from './MachinePromptDialog'

let host: HTMLDivElement
let root: Root
let onPrompt: (prompt: MachinePrompt) => void
let onCancel: (id: string) => void
const answerMachinePrompt = vi.fn()

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  installDesktopPort({
    onMachinePrompt: (l: typeof onPrompt) => { onPrompt = l; return () => {} },
    onMachinePromptCancel: (l: typeof onCancel) => { onCancel = l; return () => {} },
    answerMachinePrompt,
  } as unknown as DesktopPort)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  installDesktopPort(null)
})

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const field = () => document.body.querySelector('input[aria-label="Answer"]') as HTMLInputElement

it('a withdrawn prompt takes what was typed into it along', async () => {
  act(() => root.render(<MachinePromptDialog />))
  act(() => {
    onPrompt({ id: 'a', machine: 'alpha', prompt: 'Password:' })
    onPrompt({ id: 'b', machine: 'beta', prompt: 'Password:' })
  })
  act(() => type(field(), 'secret-for-alpha'))
  // alpha's ssh stops waiting; beta's prompt shows next.
  act(() => onCancel('a'))
  expect(document.body.textContent).toContain('Sign in to beta')
  expect(field().value).toBe('')
  act(() => (field().form as HTMLFormElement).requestSubmit())
  expect(answerMachinePrompt).toHaveBeenCalledWith('b', '')
})
