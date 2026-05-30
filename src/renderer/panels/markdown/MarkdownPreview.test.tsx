// Regression test for the "diagram jumps in preview" bug: react-markdown was
// given inline `components`/`remarkPlugins` literals (recreated every render),
// which gave the diagram children unstable component identities — so any parent
// re-render (EditorPanel subscribes to the whole workspaces store) unmounted +
// remounted MermaidDiagram/PlantUmlDiagram, re-running the async render and
// reloading the <img>. This asserts the diagram is NOT remounted on re-render.

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

let mermaidMounts = 0

// Stand-in diagram components that count their own mounts. Avoids the real
// mermaid lazy import / electronAPI under jsdom.
vi.mock('./MermaidDiagram', () => ({
  MermaidDiagram: ({ code }: { code: string }) => {
    React.useEffect(() => {
      mermaidMounts += 1
    }, [])
    return <div data-testid="mermaid">{code}</div>
  },
}))
vi.mock('./PlantUmlDiagram', () => ({
  PlantUmlDiagram: ({ code }: { code: string }) => <div data-testid="plantuml">{code}</div>,
}))

import { MarkdownPreview } from './MarkdownPreview'

const MD = '# Title\n\n```mermaid\nflowchart TD\n  A-->B\n```\n'

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  mermaidMounts = 0
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  host.remove()
})

describe('MarkdownPreview', () => {
  it('routes a mermaid fence to the MermaidDiagram component', () => {
    act(() => {
      root.render(<MarkdownPreview content={MD} />)
    })
    expect(host.querySelector('[data-testid="mermaid"]')?.textContent).toContain('flowchart TD')
    expect(mermaidMounts).toBe(1)
  })

  it('does not remount the diagram when the parent re-renders (the jump bug)', () => {
    act(() => {
      root.render(<MarkdownPreview content={MD} />)
    })
    expect(mermaidMounts).toBe(1)
    // A parent re-render with identical content must reconcile the diagram in
    // place, not tear it down and mount a fresh one.
    act(() => {
      root.render(<MarkdownPreview content={MD} />)
    })
    expect(mermaidMounts).toBe(1)
  })
})
