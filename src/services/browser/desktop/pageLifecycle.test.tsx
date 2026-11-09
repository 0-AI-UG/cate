import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { afterEach, expect, it, vi } from 'vitest'
import { createPageLifecycle } from './pageLifecycle'

afterEach(() => { document.body.replaceChildren() })

function setup() {
  const executeJavaScript = vi.fn(async (script: string) => window.eval(script))
  const page = Object.assign(new EventEmitter(), {
    id: 1, isDestroyed: () => false, isLoading: () => false, isCurrentlyAudible: () => false,
    mainFrame: { framesInSubtree: [{ executeJavaScript }] },
    navigationHistory: { getAllEntries: () => [{ url: 'https://example.com' }] },
  })
  const lifecycle = createPageLifecycle({ busy: () => false })
  const host = document.createElement('div')
  document.body.append(host)
  const outer = host.attachShadow({ mode: 'open' })
  const inner = document.createElement('div')
  outer.append(inner)
  const shadow = inner.attachShadow({ mode: 'open' })
  return { shadow, discard: () => lifecycle.prepareDiscard(page as unknown as WebContents) }
}

it('preserves silent playing media in nested shadow roots and permits paused media', async () => {
  const { shadow, discard } = setup()
  const video = document.createElement('video')
  video.muted = true
  Object.defineProperty(video, 'paused', { configurable: true, value: false })
  shadow.append(video)
  expect(await discard()).toBe(false)
  Object.defineProperty(video, 'paused', { value: true })
  expect(await discard()).toBe(true)
})

it('preserves editable content and programmatically edited forms in nested shadow roots', async () => {
  const { shadow, discard } = setup()
  shadow.innerHTML = '<div contenteditable="true"></div>'
  expect(await discard()).toBe(false)
  shadow.innerHTML = '<input value="original"><textarea>original</textarea><select><option selected>A</option><option>B</option></select>'
  expect(await discard()).toBe(true)
  const input = shadow.querySelector('input')!
  input.value = 'unsaved'
  expect(await discard()).toBe(false)
  input.value = input.defaultValue
  const textarea = shadow.querySelector('textarea')!
  textarea.value = 'unsaved'
  expect(await discard()).toBe(false)
  textarea.value = textarea.defaultValue
  shadow.querySelector('select')!.selectedIndex = 1
  expect(await discard()).toBe(false)
})
