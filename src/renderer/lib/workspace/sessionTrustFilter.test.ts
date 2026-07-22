// =============================================================================
// The workspace trust boundary (GHSA-8769-jp52-985f).
//
// The advisory's chain was: a committed `.cate/workspace.json` restores an
// `agent` panel → the panel mounts pi → pi loads the auto-installed MCP adapter
// → the adapter starts the repo's eager `.pi/mcp.json` command. These tests pin
// the first link shut, using the advisory's own proof-of-concept file as the
// primary fixture.
// =============================================================================

import { describe, it, expect } from 'vitest'
import {
  filterUntrustedProjectFiles,
  pruneLayout,
  isInsideRoot,
  describeWithheld,
} from './sessionTrustFilter'
import type { ProjectWorkspaceFile, ProjectSessionFile } from '../../../shared/types'

const ROOT = '/tmp/throwaway-repo'

/** Verbatim shape of the advisory's proof-of-concept `.cate/workspace.json`. */
function poCWorkspaceFile(): ProjectWorkspaceFile {
  return {
    version: 1,
    name: 'Cate MCP PoC',
    color: '',
    panels: {
      'agent-poc': { type: 'agent', title: 'Agent' },
    },
    dockState: {
      zones: {
        left: { position: 'left', visible: false, size: 0, layout: null },
        right: { position: 'right', visible: false, size: 0, layout: null },
        bottom: { position: 'bottom', visible: false, size: 0, layout: null },
        center: {
          position: 'center',
          visible: true,
          size: 0,
          layout: { type: 'tabs', id: 'agent-poc-tabs', panelIds: ['agent-poc'], activeIndex: 0 },
        },
      },
    },
  } as ProjectWorkspaceFile
}

describe('filterUntrustedProjectFiles — the advisory PoC', () => {
  it('drops the repo-supplied agent panel entirely', () => {
    const { workspace, withheld } = filterUntrustedProjectFiles(poCWorkspaceFile(), null, ROOT)

    expect(workspace.panels).toEqual({})
    expect(withheld.byType.agent).toBe(1)
    expect(withheld.total).toBe(1)
  })

  it('leaves no dock reference to the dropped panel', () => {
    const { workspace } = filterUntrustedProjectFiles(poCWorkspaceFile(), null, ROOT)

    // An orphaned tab stack would either resurrect the panel record or render an
    // empty stack; the whole layout must collapse to null instead.
    expect(workspace.dockState?.zones.center.layout).toBeNull()
  })

  it('preserves the shareable non-executable metadata', () => {
    const { workspace } = filterUntrustedProjectFiles(poCWorkspaceFile(), null, ROOT)

    expect(workspace.name).toBe('Cate MCP PoC')
    expect(workspace.version).toBe(1)
  })
})

describe('filterUntrustedProjectFiles — panel types', () => {
  const ws = {
    version: 1,
    name: 'mixed',
    color: '',
    panels: {
      ed: { type: 'editor', title: 'README.md', filePath: 'README.md' },
      cv: { type: 'canvas', title: 'Canvas' },
      doc: { type: 'document', title: 'Spec', filePath: 'docs/spec.pdf' },
      term: { type: 'terminal', title: 'Terminal' },
      br: { type: 'browser', title: 'Browser' },
      ag: { type: 'agent', title: 'Agent' },
      ext: { type: 'extension', title: 'Ext', extensionId: 'cate.evil' },
    },
  } as unknown as ProjectWorkspaceFile

  it('keeps passive panels and withholds every process-bearing one', () => {
    const { workspace, withheld } = filterUntrustedProjectFiles(ws, null, ROOT)

    expect(Object.keys(workspace.panels ?? {}).sort()).toEqual(['cv', 'doc', 'ed'])
    expect(withheld.total).toBe(4)
    expect(withheld.byType).toEqual({ terminal: 1, browser: 1, agent: 1, extension: 1 })
  })
})

describe('filterUntrustedProjectFiles — side-effecting fields', () => {
  it('strips proxyUrl and tabs even from a panel type that survives', () => {
    // A repo can set these on any panel record; `proxyUrl` would route traffic
    // through an attacker's proxy and `tabs` names URLs to load.
    const ws = {
      version: 1,
      name: 'sneaky',
      color: '',
      panels: {
        ed: {
          type: 'editor',
          title: 'README.md',
          filePath: 'README.md',
          proxyUrl: 'http://attacker.example:8080',
          tabs: [{ id: 't1', url: 'https://attacker.example' }],
          extensionId: 'cate.evil',
        },
      },
    } as unknown as ProjectWorkspaceFile

    const { workspace } = filterUntrustedProjectFiles(ws, null, ROOT)
    const ed = workspace.panels?.ed as unknown as Record<string, unknown>

    expect(ed.filePath).toBe('README.md')
    expect(ed.proxyUrl).toBeUndefined()
    expect(ed.tabs).toBeUndefined()
    expect(ed.extensionId).toBeUndefined()
  })
})

describe('filterUntrustedProjectFiles — path containment', () => {
  it('withholds an editor panel pointing outside the project', () => {
    const ws = {
      version: 1,
      name: 'exfil',
      color: '',
      panels: {
        a: { type: 'editor', title: 'key', filePath: '/Users/victim/.ssh/id_rsa' },
        b: { type: 'editor', title: 'climb', filePath: '../../../etc/passwd' },
        c: { type: 'editor', title: 'ok', filePath: 'src/index.ts' },
      },
    } as unknown as ProjectWorkspaceFile

    const { workspace, withheld } = filterUntrustedProjectFiles(ws, null, ROOT)

    expect(Object.keys(workspace.panels ?? {})).toEqual(['c'])
    expect(withheld.byType.editor).toBe(2)
  })
})

describe('filterUntrustedProjectFiles — session.json is untrusted too', () => {
  it('drops session panel facts, detached windows and worktrees', () => {
    // .cate/session.json is gitignored, but a hostile repo can commit it anyway,
    // so it gets no more trust than workspace.json.
    const sess = {
      version: 1,
      workspaceId: 'ws-1',
      panels: {
        ed: { panelId: 'ed', workingDirectory: '/etc', agentSession: 'resume-me' },
      },
      dockWindows: [{ workspaceId: 'ws-1' }],
      worktrees: [{ id: 'wt', path: '/tmp/elsewhere' }],
    } as unknown as ProjectSessionFile

    const ws = {
      version: 1, name: 'x', color: '',
      panels: { ed: { type: 'editor', title: 'a', filePath: 'a.ts' } },
    } as unknown as ProjectWorkspaceFile

    const { session } = filterUntrustedProjectFiles(ws, sess, ROOT)

    expect(session?.panels).toEqual({})
    expect(session?.dockWindows).toBeUndefined()
    expect(session?.worktrees).toBeUndefined()
    // Identity is harmless and must survive so the workspace still matches up.
    expect(session?.workspaceId).toBe('ws-1')
  })
})

describe('pruneLayout', () => {
  const allowed = new Set(['keep1', 'keep2'])

  it('drops disallowed ids from a stack and keeps the active panel', () => {
    const pruned = pruneLayout(
      { type: 'tabs', id: 's', panelIds: ['evil', 'keep1', 'keep2'], activeIndex: 2 },
      allowed,
    )
    expect(pruned).toEqual({ type: 'tabs', id: 's', panelIds: ['keep1', 'keep2'], activeIndex: 1 })
  })

  it('falls back to the first tab when the active one was dropped', () => {
    const pruned = pruneLayout(
      { type: 'tabs', id: 's', panelIds: ['evil', 'keep1'], activeIndex: 0 },
      allowed,
    )
    expect(pruned).toMatchObject({ panelIds: ['keep1'], activeIndex: 0 })
  })

  it('returns null for a stack that empties out', () => {
    expect(pruneLayout({ type: 'tabs', id: 's', panelIds: ['evil'], activeIndex: 0 }, allowed)).toBeNull()
  })

  it('collapses a split down to its single surviving child', () => {
    const pruned = pruneLayout(
      {
        type: 'split', id: 'sp', direction: 'horizontal', ratios: [0.5, 0.5],
        children: [
          { type: 'tabs', id: 'a', panelIds: ['evil'], activeIndex: 0 },
          { type: 'tabs', id: 'b', panelIds: ['keep1'], activeIndex: 0 },
        ],
      },
      allowed,
    )
    expect(pruned).toMatchObject({ type: 'tabs', id: 'b' })
  })

  it('re-normalizes ratios when a split loses a child', () => {
    const pruned = pruneLayout(
      {
        type: 'split', id: 'sp', direction: 'horizontal', ratios: [0.2, 0.4, 0.4],
        children: [
          { type: 'tabs', id: 'a', panelIds: ['evil'], activeIndex: 0 },
          { type: 'tabs', id: 'b', panelIds: ['keep1'], activeIndex: 0 },
          { type: 'tabs', id: 'c', panelIds: ['keep2'], activeIndex: 0 },
        ],
      },
      allowed,
    )
    expect(pruned).toMatchObject({ type: 'split', ratios: [0.5, 0.5] })
  })
})

describe('isInsideRoot', () => {
  it.each([
    ['README.md', true],
    ['src/deep/file.ts', true],
    ['./src/a.ts', true],
    ['../outside.ts', false],
    ['src/../../outside.ts', false],
    ['/etc/passwd', false],
    ['/tmp/throwaway-repo-evil/x.ts', false], // prefix match must not pass
    ['/tmp/throwaway-repo/x.ts', true],
  ])('%s → %s', (p, expected) => {
    expect(isInsideRoot(p, ROOT)).toBe(expected)
  })
})

describe('describeWithheld', () => {
  it('renders one type', () => {
    expect(describeWithheld({ byType: { agent: 1 }, total: 1 })).toBe('1 Agent panel')
  })

  it('pluralizes and joins several types', () => {
    expect(describeWithheld({ byType: { agent: 1, browser: 2 }, total: 3 }))
      .toBe('1 Agent panel and 2 browser panels')
  })

  it('is empty when nothing was withheld', () => {
    expect(describeWithheld({ byType: {}, total: 0 })).toBe('')
  })
})
