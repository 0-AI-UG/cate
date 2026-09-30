import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { installMockClientUi } from '@kernel/ui/testing'
import { SkillsSettings } from './SkillsSettings'
import { installFakeSkills } from './testRuntime'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLDivElement
let fake: ReturnType<typeof installFakeSkills>

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  installMockClientUi()
  fake = installFakeSkills('ws', { sources: [{ id: 's1', repo: 'owner/one' }] })
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  fake.remove()
})

const button = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.getAttribute('aria-label') === label || b.textContent?.trim() === label)!

it('lists, adds and removes (after confirming) workspace sources', async () => {
  await act(async () => root.render(<SkillsSettings workspaceId="ws" />))
  expect(host.textContent).toContain('owner/one')

  const input = host.querySelector<HTMLInputElement>('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'owner/two')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => button('Add').click())
  expect(fake.skills.addSource).toHaveBeenCalledWith({ repo: 'owner/two' })

  await act(async () => button('Remove').click())
  expect(fake.skills.removeSource).not.toHaveBeenCalled()
  await act(async () => button('Confirm removal').click())
  expect(fake.skills.removeSource).toHaveBeenCalledWith({ id: 's1' })
})

it('shows why a source could not be added', async () => {
  fake.skills.addSource.mockRejectedValue(new Error('Invalid repo: nope'))
  await act(async () => root.render(<SkillsSettings workspaceId="ws" />))
  const input = host.querySelector<HTMLInputElement>('input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'nope')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => button('Add').click())
  expect(host.textContent).toContain('Invalid repo: nope')
})
