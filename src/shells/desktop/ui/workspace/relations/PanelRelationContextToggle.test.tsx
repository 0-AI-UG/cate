import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { documentStoreFor } from '@client/document'
import { MAIN_WINDOW, createDocument, type PanelRecord } from '@workspace/document/contract'
import { PanelRelationContextToggle } from './PanelRelationContextToggle'
import { installRelationUiPort, type RelationMenuItem } from './port'
import { openTestDocument, testRelationHost } from '../../client/layout/canvas/testing'
import { PANEL_DEFINITIONS } from '@panels/definitions'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const source: PanelRecord = { id: 'source', type: 'terminal', title: 'Terminal', fields: {} }
const docs: PanelRecord = { id: 'docs', type: 'browser', title: 'Docs', fields: {} }

const setOff = () => {
  documentStoreFor('ws')!.propose({ kind: 'updatePanel', id: 'source', patch: { fields: { relationContextMode: 'off' } } })
}

describe('PanelRelationContextToggle', () => {
  let host: HTMLDivElement
  let root: Root
  let detach: () => void
  let supported: boolean
  let sentAt: number | undefined
  let blocked: { label: string; reason: string; fix?: { label: string; run(): void } } | undefined
  let settings: ReturnType<typeof testRelationHost>
  const showMenu = vi.fn<(items: RelationMenuItem[]) => Promise<string | null>>(async () => null)
  const openTextPreview = vi.fn(async () => 'preview-panel')

  beforeEach(() => {
    supported = true
    sentAt = undefined
    blocked = undefined
    settings = testRelationHost({ definitions: [...PANEL_DEFINITIONS] })
    showMenu.mockReset().mockResolvedValue(null)
    openTextPreview.mockClear()
    installRelationUiPort({
      showMenu,
      openTextPreview,
      useContextTransport: () => (supported ? { decorate: (text) => `${text}\nguidance`, sentAt, blocked } : null),
    })
    detach = openTestDocument('ws', {
      ...createDocument(),
      panels: { source, docs },
      windows: { [MAIN_WINDOW]: { id: MAIN_WINDOW, kind: 'main', dock: { kind: 'stack', id: 'main', panels: ['source', 'docs'] } } },
      relations: { relation: { id: 'relation', fromPanelId: 'source', toPanelId: 'docs', kind: 'use' } },
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    detach()
    installRelationUiPort(null)
    settings.uninstall()
  })

  it('hides when the running agent has no native context hook', () => {
    supported = false
    act(() => root.render(<PanelRelationContextToggle panel={source} workspaceId="ws" />))
    expect(host.querySelector('button')).toBeNull()
  })

  it('hides on a panel that cannot take a prompt', () => {
    act(() => root.render(<PanelRelationContextToggle panel={docs} workspaceId="ws" />))
    expect(host.querySelector('button')).toBeNull()
  })

  it('spells out armed context', async () => {
    await act(async () => root.render(<PanelRelationContextToggle panel={source} workspaceId="ws" />))
    const label = host.querySelector('button span') as HTMLSpanElement
    expect(label.style.maxWidth).toBe('180px')
    expect(label.textContent).toBe('1 panel · Next')
  })

  it('says for a moment that context was sent', async () => {
    vi.useFakeTimers()
    try {
      setOff()
      sentAt = 1
      await act(async () => root.render(<PanelRelationContextToggle panel={source} workspaceId="ws" />))
      const label = () => host.querySelector('button span') as HTMLSpanElement
      expect(label().textContent).toBe('1 panel · Off')
      sentAt = 2
      await act(async () => root.render(<PanelRelationContextToggle panel={{ ...source }} workspaceId="ws" />))
      expect(label().textContent).toBe('Context sent · 1 panel')
      expect(label().style.maxWidth).toBe('180px')
      await act(async () => { vi.advanceTimersByTime(4000) })
      expect(label().style.maxWidth).toBe('0px')
    } finally {
      vi.useRealTimers()
    }
  })

  it('collapses to its icon when off and reveals the mode label on hover', async () => {
    setOff()
    await act(async () => root.render(<PanelRelationContextToggle panel={source} workspaceId="ws" />))
    const button = host.querySelector<HTMLButtonElement>('button')!
    const label = button.querySelector<HTMLSpanElement>('span')!
    expect(label.style.maxWidth).toBe('0px')
    expect(label.style.opacity).toBe('0')
    await act(async () => { button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    expect(label.style.maxWidth).toBe('180px')
    expect(label.style.opacity).toBe('1')
  })

  it('offers explicit modes and records the chosen one', async () => {
    showMenu.mockResolvedValueOnce('off')
    await act(async () => root.render(<PanelRelationContextToggle panel={source} workspaceId="ws" />))
    await act(async () => { host.querySelector('button')!.click() })
    expect(documentStoreFor('ws')!.getSnapshot().panels.source.fields.relationContextMode).toBe('off')
    expect(showMenu).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ label: '1 connected panel attached', enabled: false }),
      expect.objectContaining({ id: 'once' }),
      expect.objectContaining({ id: 'always' }),
      expect.objectContaining({ id: 'off' }),
      expect.objectContaining({ id: 'preview', label: 'Preview sent context…' }),
    ]))
  })

  it('opens the exact context in an unsaved text panel from the preview action', async () => {
    showMenu.mockResolvedValueOnce('preview')
    await act(async () => root.render(<PanelRelationContextToggle panel={source} workspaceId="ws" />))
    await act(async () => { host.querySelector('button')!.click() })
    expect(openTextPreview).toHaveBeenCalledWith({
      workspaceId: 'ws',
      sourcePanelId: 'source',
      title: 'Connected panel context.md',
      content: expect.stringContaining('<cate-connected-panels>'),
    })
    expect(openTextPreview.mock.calls[0]).toBeDefined()
    const menu = showMenu.mock.calls[0][0]
    expect(menu.some((item) => 'label' in item && item.label?.includes('must use'))).toBe(false)
  })

  it('warns while the agent cannot take context and offers the fix', async () => {
    const fix = vi.fn()
    blocked = { label: 'Hooks off', reason: 'Claude Code runs without Cate hooks.', fix: { label: 'Agent hooks settings…', run: fix } }
    showMenu.mockResolvedValueOnce('fix')
    await act(async () => root.render(<PanelRelationContextToggle panel={source} workspaceId="ws" />))
    const button = host.querySelector('button')!
    expect(button.querySelector('span')!.textContent).toBe('1 panel · Hooks off')
    expect(button.title).toBe('Claude Code runs without Cate hooks.')
    await act(async () => { button.click() })
    expect(showMenu.mock.calls[0][0].slice(0, 2)).toEqual([
      { label: 'Claude Code runs without Cate hooks.', enabled: false },
      { id: 'fix', label: 'Agent hooks settings…' },
    ])
    expect(fix).toHaveBeenCalled()
  })

  it('warns without a fix when the agent cannot take context at all', async () => {
    blocked = { label: 'Not supported', reason: 'Cursor cannot take context from Cate.' }
    await act(async () => root.render(<PanelRelationContextToggle panel={source} workspaceId="ws" />))
    const button = host.querySelector('button')!
    expect(button.getAttribute('aria-label')).toBe('1 connected panels, not sent: Not supported')
    expect(button.querySelector('span')!.textContent).toBe('1 panel · Not supported')
    await act(async () => { button.click() })
    const menu = showMenu.mock.calls[0][0]
    expect(menu[0]).toEqual({ label: 'Cursor cannot take context from Cate.', enabled: false })
    expect(menu.some((item) => 'id' in item && item.id === 'fix')).toBe(false)
  })
})
