// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import path from 'node:path'
import React, { act } from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { patchT3ClientSource } from './patch-t3-client.mjs'

const directory = path.resolve('node_modules/t3/dist/client/assets')
const entry = readdirSync(directory).find((name) => /^ChatView-.*\.js$/.test(name))
const source = patchT3ClientSource(readFileSync(path.join(directory, entry), 'utf8'))

// Execute the actual patched summary component and hook with React. Only its
// unchanged file-list child is replaced; the compiler cache retains React state.
function summaryComponent() {
  const start = source.indexOf('var HS=(0,X.memo)(function(e)')
  const end = source.indexOf(';function US', start)
  const helpers = source.slice(source.indexOf('const cateEmptyFiles=[];'), source.indexOf('/* cate: checkpoint-independent summaries */'))
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return runInNewContext(`${helpers};${source.slice(start, end)};HS`, {
    X: React, Q: jsxRuntime, window,
    Z: { c: (size) => React.useMemo(() => Array(size).fill(Symbol.for('react.memo_cache_sentinel')), []) },
    US: ({ checkpointFiles }) => React.createElement('div', { 'data-testid': 'files' }, checkpointFiles.map((f) => f.path).join(',')),
  })
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let host, root
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove(); delete window.__cateHost; delete window.__cateChanges })

describe('bundled T3 recorded summary rendering', () => {
  it('updates a memoized summary from capture events without showing checkpoint files', () => {
    window.__cateHost = {}
    const Summary = summaryComponent()
    const onOpenTurnDiff = vi.fn()
    const turnSummary = { turnId: 'turn', files: [{ path: 'unrelated-checkout.ts' }] }
    act(() => root.render(React.createElement(Summary, { turnSummary, onOpenTurnDiff })))
    expect(host.querySelector('button').textContent).toContain('No recorded edits')
    act(() => host.querySelector('button').click())
    expect(onOpenTurnDiff).toHaveBeenCalledWith('turn')
    act(() => {
      window.__cateChanges = { turns: { turn: [{ path: 'agent.ts' }] } }
      window.dispatchEvent(new Event('cate-changes'))
    })
    expect(host.querySelector('[data-testid="files"]').textContent).toBe('agent.ts')
    expect(host.textContent).not.toContain('unrelated-checkout.ts')
    expect(host.textContent).toContain('Recorded edits; unreported changes may be missing.')
    act(() => {
      window.__cateChanges = { turns: {} }
      window.dispatchEvent(new Event('cate-changes'))
    })
    expect(host.querySelector('button').textContent).toContain('No recorded edits')
  })

  it('preserves upstream checkpoint summaries outside the Cate host', () => {
    const Summary = summaryComponent()
    act(() => root.render(React.createElement(Summary, { turnSummary: { turnId: 'turn', files: [{ path: 'checkpoint.ts' }] } })))
    expect(host.querySelector('[data-testid="files"]').textContent).toBe('checkpoint.ts')
    expect(host.textContent).not.toContain('unreported changes may be missing')
  })
})
