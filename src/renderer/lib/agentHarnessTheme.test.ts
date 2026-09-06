// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { agentHarnessThemeScript } from './agentHarnessTheme'
import { BUILT_IN_BY_ID } from '../../shared/themes'

const guestWindow = window as typeof window & { __cateThemeObserver?: MutationObserver }
afterEach(() => {
  guestWindow.__cateThemeObserver?.disconnect()
  document.getElementById('cate-agent-theme')?.remove()
  document.documentElement.className = ''
  delete document.documentElement.dataset.themeId
})

it('resolves partial custom palettes and replaces the guest theme without touching its content', async () => {
  const draft = document.createElement('textarea')
  draft.value = 'Keep this draft'
  document.body.appendChild(draft)
  const custom = { ...BUILT_IN_BY_ID['dark-cold'], id: 'custom', app: { 'surface-4': '#123456', 'focus-blue': '#abcdef' } }
  new Function(agentHarnessThemeScript(custom))()
  expect(getComputedStyle(document.documentElement).getPropertyValue('--background').trim()).toBe('#123456')
  expect(getComputedStyle(document.documentElement).getPropertyValue('--primary').trim()).toBe('#abcdef')
  expect(getComputedStyle(document.documentElement).getPropertyValue('--foreground').trim()).toBe('#e8e6e3')
  expect(document.documentElement.classList.contains('dark')).toBe(true)

  new Function(agentHarnessThemeScript(BUILT_IN_BY_ID['light-subtle']))()
  expect(document.querySelectorAll('#cate-agent-theme')).toHaveLength(1)
  expect(document.documentElement.classList.contains('dark')).toBe(false)
  expect(getComputedStyle(document.documentElement).colorScheme).toBe('light')
  expect(draft.value).toBe('Keep this draft')

  // Late upstream theme initialization must not restore its own dark mode.
  document.documentElement.classList.add('dark')
  document.documentElement.dataset.themeId = 'upstream'
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(document.documentElement.classList.contains('dark')).toBe(false)
  expect(document.documentElement.dataset.themeId).toBe('cate')
  draft.remove()
})
