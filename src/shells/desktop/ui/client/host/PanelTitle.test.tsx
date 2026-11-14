import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { registerPanelDefinitions } from '@client/host'
import { PANEL_DEFINITIONS } from '@panels/definitions'
import { PanelTitle } from './PanelTitle'

registerPanelDefinitions(PANEL_DEFINITIONS)

it('shares logo, activity, status and derived title rendering and falls back after logo failure', () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const record = { type: 'terminal', title: 'Terminal 1' }
  try {
    act(() => root.render(<PanelTitle record={record} decoration={{ logo: 'agent.svg', logoAlt: 'Agent', busy: true, retitle: () => 'Implement login', status: <span aria-label="Waiting for input" /> }} />))
    expect(host.querySelector('img')?.getAttribute('src')).toBe('agent.svg')
    expect(host.querySelector('.cate-shimmer')?.textContent).toContain('Implement login')
    expect(host.querySelector('[aria-label="Waiting for input"]')).not.toBeNull()
    act(() => host.querySelector('img')!.dispatchEvent(new Event('error')))
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('svg')).not.toBeNull()
    act(() => root.render(<PanelTitle record={record} decoration={{ logo: 'another-agent.svg' }} />))
    expect(host.querySelector('img')?.getAttribute('src')).toBe('another-agent.svg')
    expect(host.querySelector('.cate-shimmer')).toBeNull()
    expect(host.textContent).toBe('Terminal 1')
  } finally { act(() => root.unmount()); host.remove() }
})
