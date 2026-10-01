// @vitest-environment jsdom

import { expect, it } from 'vitest'
import type { PanelState } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { createTransferSnapshot, hydrateReceivedPanel } from './panelTransfer'

const panels: Record<string, PanelState> = {
  c: { id: 'c', type: 'container', title: 'Container', isDirty: false, containerLayout: {
    type: 'split', id: 's', direction: 'horizontal', ratios: [0.5, 0.5], children: [
      { type: 'tabs', id: 't1', panelIds: ['a'], activeIndex: 0 },
      { type: 'tabs', id: 't2', panelIds: ['b'], activeIndex: 0 },
    ] } },
  a: { id: 'a', type: 'editor', title: 'A', isDirty: false },
  b: { id: 'b', type: 'browser', title: 'B', isDirty: false },
}

it('carries a container\'s children to the receiving window', () => {
  const snapshot = createTransferSnapshot(
    panels.c, { type: 'dock', zone: 'center', stackId: 'x' },
    { origin: { x: 0, y: 0 }, size: { width: 800, height: 600 } },
    { resolveChildPanel: (id) => panels[id] },
  )
  expect(Object.keys(snapshot.containerState!.childPanels).sort()).toEqual(['a', 'b'])

  useAppStore.setState({ workspaces: [] } as never)
  hydrateReceivedPanel('detached', snapshot)
  const received = useAppStore.getState().workspaces.find((w) => w.id === 'detached')!
  expect(Object.keys(received.panels).sort()).toEqual(['a', 'b'])
})
