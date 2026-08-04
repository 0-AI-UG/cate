import { describe, expect, it } from 'vitest'
import {
  agentBrowserCommandShowsActivity,
  isReadOnlyAgentBrowserCommand,
  validateAgentBrowserCommand,
} from './agentBrowserCommand'
import { cliPermissionForRequest } from './cliPermissions'

describe('agent-browser command boundary', () => {
  it('separates observing and acting commands', () => {
    expect(isReadOnlyAgentBrowserCommand(['snapshot', '-i'])).toBe(true)
    expect(isReadOnlyAgentBrowserCommand(['console'])).toBe(true)
    expect(isReadOnlyAgentBrowserCommand(['console', '--clear'])).toBe(false)
    expect(isReadOnlyAgentBrowserCommand(['wait', '--text', 'Ready'])).toBe(true)
    expect(isReadOnlyAgentBrowserCommand(['wait', '--fn', 'document.body.remove()'])).toBe(false)
    expect(isReadOnlyAgentBrowserCommand(['wait', '--fn=document.body.remove()'])).toBe(false)
    expect(isReadOnlyAgentBrowserCommand(['click', '@s1e1'])).toBe(false)
  })

  it('rejects process, session, tab, and filesystem escape hatches', () => {
    expect(() => validateAgentBrowserCommand(['connect', '9222'])).toThrow()
    expect(() => validateAgentBrowserCommand(['tab', 'new'])).toThrow()
    expect(() => validateAgentBrowserCommand(['click', '#x', '--cdp', '9222'])).toThrow()
    expect(() => validateAgentBrowserCommand(['click', '#x', '--session=other'])).toThrow()
    expect(() => validateAgentBrowserCommand(['get', 'cdp-url'])).toThrow()
    expect(() => validateAgentBrowserCommand(['screenshot', '/tmp/x.png'])).toThrow()
    expect(() => validateAgentBrowserCommand(['wait', '--download', '/tmp/x.zip'])).toThrow()
    expect(() => validateAgentBrowserCommand(['wait', '--download=/tmp/x.zip'])).toThrow()
  })

  it('allows Cate refs for element screenshots and marks visible actions', () => {
    expect(validateAgentBrowserCommand(['screenshot', '@s3e9', '--annotate']))
      .toEqual(['screenshot', '@s3e9', '--annotate'])
    expect(agentBrowserCommandShowsActivity(['fill', '@s1e1', 'x'])).toBe(true)
    expect(agentBrowserCommandShowsActivity(['snapshot'])).toBe(false)
    expect(validateAgentBrowserCommand(['wait', '@s2e2', '--state', 'visible', '--timeout', '3000']))
      .toEqual(['wait', '@s2e2', '--state', 'visible', '--timeout', '3000'])
  })

  it('cannot smuggle an action through the read permission envelope', () => {
    expect(cliPermissionForRequest('cate.browser.readCommand', {
      command: ['snapshot', '-i'],
    })?.key).toBe('cliBrowserReadEnabled')
    expect(cliPermissionForRequest('cate.browser.readCommand', {
      command: ['click', '@s1e1'],
    })?.key).toBe('cliBrowserControlEnabled')
    expect(cliPermissionForRequest('cate.browser.readCommand', {
      command: ['wait', '--fn', 'document.body.remove()'],
    })?.key).toBe('cliBrowserControlEnabled')
    expect(cliPermissionForRequest('cate.panel.target.set', {})?.key).toBe('cliPanelReadEnabled')
  })
})
