import { describe, expect, it } from 'vitest'
import {
  T3_CHAT_ONLY_CSS,
  t3BrandingScript,
  t3ThreadIdFromUrl,
  isT3ProviderSettingsNavigation,
  isAllowedT3Navigation,
} from './surface'

const HARNESS = 'http://127.0.0.1:49152/pair#secret'
const ENV = 'local-env'

describe('T3 chat-only surface', () => {
  it('hides embedded navigation and Cate-owned controls', () => {
    expect(T3_CHAT_ONLY_CSS).toContain('[data-slot="sidebar"],')
    expect(T3_CHAT_ONLY_CSS).toContain('[data-slot="sidebar-gap"]')
    expect(T3_CHAT_ONLY_CSS).toContain('[data-app-sidebar]')
    expect(T3_CHAT_ONLY_CSS).toContain('[data-slot="sidebar-header"]')
    expect(T3_CHAT_ONLY_CSS).toContain('[data-sidebar="trigger"]')
    expect(T3_CHAT_ONLY_CSS).not.toContain('[data-sidebar="group"] > div')
    expect(T3_CHAT_ONLY_CSS).toContain('[data-slot="sidebar-footer"]')
    expect(T3_CHAT_ONLY_CSS).toContain('svg[aria-label="T3"]')
    expect(T3_CHAT_ONLY_CSS).toContain('button[aria-label="Filter threads by project"]')
    expect(T3_CHAT_ONLY_CSS).toContain('button[aria-label="New project"]')
    expect(T3_CHAT_ONLY_CSS).toContain('[data-slot="composer-context-strip"]')
    expect(T3_CHAT_ONLY_CSS).toContain('[data-slot="composer-shell"][data-with-context="true"]::before')
    expect(T3_CHAT_ONLY_CSS).toContain('[data-slot="composer-host"]::after')
    expect(T3_CHAT_ONLY_CSS).toContain('[data-slot="composer-shell"]::before')
    expect(T3_CHAT_ONLY_CSS).toContain('[data-composer-banner-surface]::before')
    expect(T3_CHAT_ONLY_CSS).toContain('[data-slot="composer-banner-peek"]')
    expect(T3_CHAT_ONLY_CSS).toContain('.alert-glass')
    expect(T3_CHAT_ONLY_CSS).toContain('.dialog-glass')
    expect(T3_CHAT_ONLY_CSS).toContain('.dropdown-glass')
    expect(T3_CHAT_ONLY_CSS).toContain('.surface-glass')
    expect(T3_CHAT_ONLY_CSS).toContain('backdrop-filter: none !important')
    expect(T3_CHAT_ONLY_CSS).toContain('.topbar-scroll-fade')
    expect(T3_CHAT_ONLY_CSS).toContain('.virtualized-scroll-fade')
    expect(T3_CHAT_ONLY_CSS).toContain('mask-image: none !important')
    expect(T3_CHAT_ONLY_CSS).toContain('[data-composer-context-control]')
    expect(T3_CHAT_ONLY_CSS).toContain('[data-workspace-titlebar-controls]')
    expect(T3_CHAT_ONLY_CSS).not.toContain('[data-preview-panel-mode]')
    expect(T3_CHAT_ONLY_CSS).toContain('[data-terminal-owner]')
    expect(T3_CHAT_ONLY_CSS).not.toContain('[data-testid*=')
    expect(T3_CHAT_ONLY_CSS).toContain('[data-right-panel-tabbar]')
    expect(T3_CHAT_ONLY_CSS).not.toContain('[data-cate-agents-control]')
    expect(T3_CHAT_ONLY_CSS).toContain('[data-chat-header]')
    expect(T3_CHAT_ONLY_CSS).not.toContain('button[aria-label="Open diff"]')
    expect(T3_CHAT_ONLY_CSS).not.toContain('[data-right-panel-surface-content]')
  })

  it('removes upstream product chrome without rewriting chat content', () => {
    const threadScript = t3BrandingScript('thread')
    const providerScript = t3BrandingScript('providers')

    expect(threadScript).toContain("document.title !== 'T3 Code'")
    expect(threadScript).toContain('MutationObserver(removeProductChrome)')
    expect(threadScript).toContain('observe(document.documentElement')
    expect(threadScript).toContain("if (\"thread\" !== 'providers') return")
    expect(providerScript).toContain('hostCopy(node.nodeValue)')
    expect(threadScript).toContain('[data-sonner-toast]')
    expect(threadScript).toContain('[data-message-id]')
  })

  it('allows pairing, drafts, bound-environment threads, and provider settings only', () => {
    expect(isAllowedT3Navigation(HARNESS, HARNESS, ENV, 'thread')).toBe(true)
    expect(isAllowedT3Navigation('http://127.0.0.1:49152/', HARNESS, ENV, 'thread')).toBe(true)
    expect(isAllowedT3Navigation('http://127.0.0.1:49152/', HARNESS, ENV, 'thread', 'existing-thread')).toBe(false)
    expect(isAllowedT3Navigation('http://127.0.0.1:49152/draft/draft-1', HARNESS, ENV, 'thread')).toBe(true)
    expect(isAllowedT3Navigation('http://127.0.0.1:49152/local-env/thread-1', HARNESS, ENV, 'thread')).toBe(true)
    expect(isAllowedT3Navigation('http://127.0.0.1:49152/pull-requests', HARNESS, ENV, 'thread')).toBe(false)
    expect(isAllowedT3Navigation('http://127.0.0.1:49152/projects/project-1', HARNESS, ENV, 'thread')).toBe(false)
    expect(isAllowedT3Navigation('http://127.0.0.1:49152/worktrees/worktree-1', HARNESS, ENV, 'thread')).toBe(false)
    expect(isAllowedT3Navigation('http://127.0.0.1:49152/branches/main', HARNESS, ENV, 'thread')).toBe(false)
    expect(isAllowedT3Navigation('http://127.0.0.1:49152/settings/connections', HARNESS, ENV, 'thread')).toBe(false)
    expect(isAllowedT3Navigation('http://127.0.0.1:49152/settings/general', HARNESS, ENV, 'thread')).toBe(false)
    expect(isAllowedT3Navigation('http://127.0.0.1:49152/settings/providers', HARNESS, ENV, 'thread')).toBe(false)
    expect(isAllowedT3Navigation('http://127.0.0.1:49152/settings/providers/codex', HARNESS, ENV, 'thread')).toBe(false)
    expect(isAllowedT3Navigation('https://example.com/', HARNESS, ENV, 'thread')).toBe(false)
    expect(isAllowedT3Navigation('http://127.0.0.1:49152/settings/providers', HARNESS, ENV, 'providers')).toBe(true)
    expect(isAllowedT3Navigation('http://127.0.0.1:49152/settings/providers/codex', HARNESS, ENV, 'providers')).toBe(true)
    expect(isAllowedT3Navigation('http://127.0.0.1:49152/', HARNESS, ENV, 'providers')).toBe(false)
    expect(isAllowedT3Navigation('http://127.0.0.1:49152/settings/connections', HARNESS, ENV, 'providers')).toBe(false)
    expect(isAllowedT3Navigation('http://127.0.0.1:49152/local-env/thread-1', HARNESS, ENV, 'providers')).toBe(false)

    expect(isAllowedT3Navigation(
      'http://127.0.0.1:49152/local-env/thread-1',
      HARNESS,
      ENV,
      'thread',
      'thread-1',
    )).toBe(true)
    expect(isAllowedT3Navigation(
      'http://127.0.0.1:49152/local-env/thread-2',
      HARNESS,
      ENV,
      'thread',
      'thread-1',
    )).toBe(false)
    expect(isAllowedT3Navigation(
      'http://127.0.0.1:49152/draft/draft-2',
      HARNESS,
      ENV,
      'thread',
      'thread-1',
    )).toBe(false)
    expect(isAllowedT3Navigation(
      'http://127.0.0.1:49152/other-env/thread-2',
      HARNESS,
      ENV,
      'thread',
      'thread-1',
    )).toBe(false)
  })

  it('recognizes same-origin provider settings for handoff to Cate settings', () => {
    expect(isT3ProviderSettingsNavigation(
      'http://127.0.0.1:49152/settings/providers',
      HARNESS,
    )).toBe(true)
    expect(isT3ProviderSettingsNavigation(
      'http://127.0.0.1:49152/settings/providers/codex',
      HARNESS,
    )).toBe(true)
    expect(isT3ProviderSettingsNavigation(
      'http://127.0.0.1:49152/settings/general',
      HARNESS,
    )).toBe(false)
    expect(isT3ProviderSettingsNavigation(
      'https://example.com/settings/providers',
      HARNESS,
    )).toBe(false)
  })

  it('captures a thread id only from the expected environment route', () => {
    expect(t3ThreadIdFromUrl('http://127.0.0.1:49152/local-env/thread-1', ENV)).toBe('thread-1')
    expect(t3ThreadIdFromUrl('http://127.0.0.1:49152/other/thread-1', ENV)).toBeNull()
    expect(t3ThreadIdFromUrl('http://127.0.0.1:49152/settings/providers', ENV)).toBeNull()
  })
})

describe('Usage navigation', () => {
  it('keeps usage on its own origin and route while allowing pairing', () => {
    expect(isAllowedT3Navigation(HARNESS, HARNESS, ENV, 'usage')).toBe(true)
    for (const path of ['/usage', '/usage?metric=tokens']) {
      expect(isAllowedT3Navigation(`http://127.0.0.1:49152${path}`, HARNESS, ENV, 'usage')).toBe(true)
    }
    for (const path of ['/', '/settings/providers', '/local-env/thread-1', '/usage/other']) {
      expect(isAllowedT3Navigation(`http://127.0.0.1:49152${path}`, HARNESS, ENV, 'usage')).toBe(false)
    }
    expect(isAllowedT3Navigation('https://example.com/usage', HARNESS, ENV, 'usage')).toBe(false)
    expect(isAllowedT3Navigation('http://127.0.0.1:49152/usage', HARNESS, ENV, 'thread')).toBe(false)
  })
})
