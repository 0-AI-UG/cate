import React, { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_SETTINGS } from '../../shared/types'
import { useSettingsStore } from '../../renderer/stores/settingsStore'
import { OrchestrationPreflight, useOrchestrationPreflight } from './OrchestrationPreflight'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function TestPreflight({ active }: { active: boolean }) {
  const state = useOrchestrationPreflight({ active, workspaceId: 'ws', rootPath: '/repo' })
  return active ? <OrchestrationPreflight state={state} /> : null
}

describe('OrchestrationPreflight', () => {
  let host: HTMLDivElement
  let root: Root
  const settingsSet = vi.fn(async () => {})

  beforeEach(() => {
    vi.stubGlobal('window', Object.assign(window, {
      electronAPI: {
        agentHooksInspect: vi.fn(async () => [
          { agentId: 'codex', folderPresent: false, injected: false },
        ]),
        settingsSet,
      },
    }))
    useSettingsStore.setState({ ...DEFAULT_SETTINGS, _loaded: true } as never)
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  })

  it('checks readiness immediately and can enable a missing hook policy', async () => {
    await act(async () => {
      root.render(<TestPreflight active />)
    })

    expect(document.body.textContent).toContain('0/6 ready')
    const list = document.body.querySelector<HTMLElement>('[data-agent-preflight-list]')!
    expect(list.children).toHaveLength(6)
    expect(list.querySelectorAll('img')).toHaveLength(6)
    expect(list.className).not.toContain('grid-cols-2')
    const codex = document.body.querySelector<HTMLElement>('[data-agent-preflight-id="codex"]')!
    expect(codex.className).toContain('h-6')
    const enable = Array.from(codex.querySelectorAll('button'))
      .find((button) => button.textContent === 'Enable')!

    act(() => enable.click())

    expect(useSettingsStore.getState().agentHookInjection.ws?.codex).toBe('on')
    expect(document.body.textContent).toContain('1/6 ready')
    expect(settingsSet).toHaveBeenCalledWith('agentHookInjection', expect.any(Object))
  })

  it('does not inspect hooks outside parallel-agent mode', async () => {
    await act(async () => {
      root.render(<TestPreflight active={false} />)
    })

    expect(window.electronAPI.agentHooksInspect).not.toHaveBeenCalled()
    expect(host.innerHTML).toBe('')
  })
})
