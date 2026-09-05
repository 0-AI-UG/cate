import { describe, expect, it } from 'vitest'
import {
  AGENT_CHAT_ONLY_CSS,
  agentHarnessBrandingScript,
  agentThreadIdFromUrl,
  isAgentProviderSettingsNavigation,
  isAllowedAgentHarnessNavigation,
} from './agentHarnessSurface'

const HARNESS = 'http://127.0.0.1:49152/pair#secret'
const ENV = 'local-env'

describe('Agent harness chat-only surface', () => {
  it('hides embedded navigation and Cate-owned controls', () => {
    expect(AGENT_CHAT_ONLY_CSS).toContain('[data-slot="sidebar"],')
    expect(AGENT_CHAT_ONLY_CSS).toContain('[data-slot="sidebar-gap"]')
    expect(AGENT_CHAT_ONLY_CSS).toContain('[data-app-sidebar]')
    expect(AGENT_CHAT_ONLY_CSS).toContain('[data-slot="sidebar-header"]')
    expect(AGENT_CHAT_ONLY_CSS).toContain('[data-sidebar="trigger"]')
    expect(AGENT_CHAT_ONLY_CSS).not.toContain('[data-sidebar="group"] > div')
    expect(AGENT_CHAT_ONLY_CSS).toContain('[data-slot="sidebar-footer"]')
    expect(AGENT_CHAT_ONLY_CSS).toContain('svg[aria-label="T3"]')
    expect(AGENT_CHAT_ONLY_CSS).toContain('button[aria-label="Filter threads by project"]')
    expect(AGENT_CHAT_ONLY_CSS).toContain('button[aria-label="New project"]')
    expect(AGENT_CHAT_ONLY_CSS).toContain('[data-slot="composer-context-strip"]')
    expect(AGENT_CHAT_ONLY_CSS).toContain('[data-slot="composer-shell"][data-with-context="true"]::before')
    expect(AGENT_CHAT_ONLY_CSS).toContain('[data-slot="composer-host"]::after')
    expect(AGENT_CHAT_ONLY_CSS).toContain('[data-composer-context-control]')
    expect(AGENT_CHAT_ONLY_CSS).toContain('[data-workspace-titlebar-controls]')
    expect(AGENT_CHAT_ONLY_CSS).toContain('[data-preview-panel-mode]')
    expect(AGENT_CHAT_ONLY_CSS).toContain('[data-terminal-owner]')
    expect(AGENT_CHAT_ONLY_CSS).not.toContain('[data-testid*=')
    expect(AGENT_CHAT_ONLY_CSS).toContain('[data-right-panel-tabbar]')
    expect(AGENT_CHAT_ONLY_CSS).toContain('button[aria-label="Open diff"]')
  })

  it('removes upstream product chrome without rewriting chat content', () => {
    const threadScript = agentHarnessBrandingScript('thread')
    const providerScript = agentHarnessBrandingScript('providers')

    expect(threadScript).toContain("document.title !== 'T3 Code'")
    expect(threadScript).toContain('MutationObserver(removeProductChrome)')
    expect(threadScript).toContain('observe(document.documentElement')
    expect(threadScript).toContain("if (\"thread\" !== 'providers') return")
    expect(providerScript).toContain('hostCopy(node.nodeValue)')
    expect(threadScript).toContain('[data-sonner-toast]')
    expect(threadScript).toContain('[data-message-id]')
  })

  it('allows pairing, drafts, bound-environment threads, and provider settings only', () => {
    expect(isAllowedAgentHarnessNavigation(HARNESS, HARNESS, ENV, 'thread')).toBe(true)
    expect(isAllowedAgentHarnessNavigation('http://127.0.0.1:49152/', HARNESS, ENV, 'thread')).toBe(true)
    expect(isAllowedAgentHarnessNavigation('http://127.0.0.1:49152/', HARNESS, ENV, 'thread', 'existing-thread')).toBe(false)
    expect(isAllowedAgentHarnessNavigation('http://127.0.0.1:49152/draft/draft-1', HARNESS, ENV, 'thread')).toBe(true)
    expect(isAllowedAgentHarnessNavigation('http://127.0.0.1:49152/local-env/thread-1', HARNESS, ENV, 'thread')).toBe(true)
    expect(isAllowedAgentHarnessNavigation('http://127.0.0.1:49152/pull-requests', HARNESS, ENV, 'thread')).toBe(false)
    expect(isAllowedAgentHarnessNavigation('http://127.0.0.1:49152/projects/project-1', HARNESS, ENV, 'thread')).toBe(false)
    expect(isAllowedAgentHarnessNavigation('http://127.0.0.1:49152/worktrees/worktree-1', HARNESS, ENV, 'thread')).toBe(false)
    expect(isAllowedAgentHarnessNavigation('http://127.0.0.1:49152/branches/main', HARNESS, ENV, 'thread')).toBe(false)
    expect(isAllowedAgentHarnessNavigation('http://127.0.0.1:49152/settings/connections', HARNESS, ENV, 'thread')).toBe(false)
    expect(isAllowedAgentHarnessNavigation('http://127.0.0.1:49152/settings/general', HARNESS, ENV, 'thread')).toBe(false)
    expect(isAllowedAgentHarnessNavigation('http://127.0.0.1:49152/settings/providers', HARNESS, ENV, 'thread')).toBe(false)
    expect(isAllowedAgentHarnessNavigation('http://127.0.0.1:49152/settings/providers/codex', HARNESS, ENV, 'thread')).toBe(false)
    expect(isAllowedAgentHarnessNavigation('https://example.com/', HARNESS, ENV, 'thread')).toBe(false)
    expect(isAllowedAgentHarnessNavigation('http://127.0.0.1:49152/settings/providers', HARNESS, ENV, 'providers')).toBe(true)
    expect(isAllowedAgentHarnessNavigation('http://127.0.0.1:49152/settings/providers/codex', HARNESS, ENV, 'providers')).toBe(true)
    expect(isAllowedAgentHarnessNavigation('http://127.0.0.1:49152/', HARNESS, ENV, 'providers')).toBe(false)
    expect(isAllowedAgentHarnessNavigation('http://127.0.0.1:49152/settings/connections', HARNESS, ENV, 'providers')).toBe(false)
    expect(isAllowedAgentHarnessNavigation('http://127.0.0.1:49152/local-env/thread-1', HARNESS, ENV, 'providers')).toBe(false)

    expect(isAllowedAgentHarnessNavigation(
      'http://127.0.0.1:49152/local-env/thread-1',
      HARNESS,
      ENV,
      'thread',
      'thread-1',
    )).toBe(true)
    expect(isAllowedAgentHarnessNavigation(
      'http://127.0.0.1:49152/local-env/thread-2',
      HARNESS,
      ENV,
      'thread',
      'thread-1',
    )).toBe(false)
    expect(isAllowedAgentHarnessNavigation(
      'http://127.0.0.1:49152/draft/draft-2',
      HARNESS,
      ENV,
      'thread',
      'thread-1',
    )).toBe(false)
    expect(isAllowedAgentHarnessNavigation(
      'http://127.0.0.1:49152/other-env/thread-2',
      HARNESS,
      ENV,
      'thread',
      'thread-1',
    )).toBe(false)
  })

  it('recognizes same-origin provider settings for handoff to Cate settings', () => {
    expect(isAgentProviderSettingsNavigation(
      'http://127.0.0.1:49152/settings/providers',
      HARNESS,
    )).toBe(true)
    expect(isAgentProviderSettingsNavigation(
      'http://127.0.0.1:49152/settings/providers/codex',
      HARNESS,
    )).toBe(true)
    expect(isAgentProviderSettingsNavigation(
      'http://127.0.0.1:49152/settings/general',
      HARNESS,
    )).toBe(false)
    expect(isAgentProviderSettingsNavigation(
      'https://example.com/settings/providers',
      HARNESS,
    )).toBe(false)
  })

  it('captures a thread id only from the expected environment route', () => {
    expect(agentThreadIdFromUrl('http://127.0.0.1:49152/local-env/thread-1', ENV)).toBe('thread-1')
    expect(agentThreadIdFromUrl('http://127.0.0.1:49152/other/thread-1', ENV)).toBeNull()
    expect(agentThreadIdFromUrl('http://127.0.0.1:49152/settings/providers', ENV)).toBeNull()
  })
})
