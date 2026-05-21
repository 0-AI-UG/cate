// Regression test for the user-reported "unsaved editor content vanishes
// when an editor panel is dragged to a detached window, but reappears when
// dragged back" bug. The transfer snapshot today only carries terminal and
// browser state — editor state is never captured, so the destination window
// renders a fresh Monaco editor with no unsavedContent.

// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'

vi.mock('./terminalRegistry', () => ({
  terminalRegistry: { getEntry: () => undefined },
}))

import { createTransferSnapshot } from './panelTransfer'
import type { PanelState } from '../../shared/types'

describe('createTransferSnapshot — editor content survival', () => {
  // The source-of-truth for the bug: the editor's local React/Monaco buffer
  // holds unsavedContent that lives only in component state. When the panel
  // is transferred to a detached window the snapshot is the ONLY channel for
  // that content. If the snapshot doesn't carry it, it's gone.
  it('captures unsaved scratch-editor content into editorState.unsavedContent', () => {
    const panel: PanelState = {
      id: 'panel-editor-1',
      type: 'editor',
      title: 'Untitled',
      isDirty: true,
      unsavedContent: 'function hello() { return 42 }',
    }
    const snapshot = createTransferSnapshot(panel, { type: 'canvas', canvasId: 'c-1', canvasNodeId: 'n-1' }, {
      origin: { x: 0, y: 0 },
      size: { width: 600, height: 400 },
    })

    expect(snapshot.editorState).toBeDefined()
    expect(snapshot.editorState?.unsavedContent).toBe('function hello() { return 42 }')
  })
})
