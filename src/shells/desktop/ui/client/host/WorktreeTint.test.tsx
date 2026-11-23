import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { createClientSettingsStore } from '@kernel/settings/client'
import { createMemoryDeviceStore } from '@kernel/state/contract'
import { MAIN_WINDOW } from '@workspace/document/contract'
import { add, attachTestWorkspace, buildDocument } from '../../../../../test/clientWorkspace'
import { clientSettingsTable } from '../../../settings'
import { installClientSettings } from '../../kernel/settings'
import { setPanelWorktreePreview, WorktreeTint } from './WorktreeTint'

it('previews a worktree only in the named workspace and leaves the panel binding intact', async () => {
  const doc = buildDocument([
    { kind: 'setWorktree', worktree: { id: 'main', path: '/repo', color: '#123456', status: 'ready' } },
    { kind: 'setWorktree', worktree: { id: 'feature', path: '/repo/feature', color: '#abcdef', status: 'ready' } },
    add('panel', { to: 'stack', dock: { windowId: MAIN_WINDOW }, stackId: 'stack' }, 'terminal', { worktreeId: 'main' }),
  ])
  const first = attachTestWorkspace('first', doc)
  const second = attachTestWorkspace('second', doc)
  const settings = createClientSettingsStore(createMemoryDeviceStore({ settings: { worktreeTint: true } }), clientSettingsTable)
  await settings.load()
  installClientSettings(settings)
  const container = document.createElement('div')
  const root = createRoot(container)
  try {
    act(() => root.render(<>
      <WorktreeTint workspaceId="first" record={doc.panels.panel} />
      <WorktreeTint workspaceId="second" record={doc.panels.panel} />
    </>))
    const [firstTint, secondTint] = container.children
    const initial = firstTint.getAttribute('style')
    expect(initial).toContain('color-mix')
    expect(secondTint.getAttribute('style')).toBe(initial)

    act(() => setPanelWorktreePreview('first', 'panel', 'feature'))
    expect(firstTint.getAttribute('style')).not.toBe(initial)
    expect(secondTint.getAttribute('style')).toBe(initial)
    expect(first.confirmed().panels.panel.worktreeId).toBe('main')
    act(() => setPanelWorktreePreview('first', 'panel', null))
    expect(firstTint.getAttribute('style')).toBe(initial)
  } finally {
    act(() => root.unmount())
    installClientSettings(null)
    settings.dispose()
    first.detach()
    second.detach()
  }
})
