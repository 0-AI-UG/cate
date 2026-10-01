// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { useAppStore } from '../../stores/appStore'
import { createDockStore } from '../../stores/dockStore'
import { containerZones } from '../../panels/containerDockRegistry'
import { collectPanelIds } from '../../../shared/collectPanelIds'
import { splitByWrappingInContainer } from './wrapInContainer'

function setup() {
  useAppStore.setState({
    selectedWorkspaceId: 'ws',
    workspaces: [{ id: 'ws', name: 'ws', color: '', rootPath: '/ws', panels: {
      a: { id: 'a', type: 'terminal', title: 'A', isDirty: false },
      b: { id: 'b', type: 'editor', title: 'B', isDirty: false },
    } }] as never,
  })
  const dock = createDockStore({ zones: containerZones({ type: 'tabs', id: 's1', panelIds: ['a'], activeIndex: 0 }) })
  return dock
}

describe('splitByWrappingInContainer', () => {
  it('replaces the target panel with a container holding target + dragged', () => {
    const dock = setup()
    const wrapped = splitByWrappingInContainer({
      workspaceId: 'ws', dockStoreApi: dock, stackId: 's1', edge: 'right',
      draggedPanelId: 'b', draggedPanelType: 'editor',
    })
    expect(wrapped).toBe(true)
    const [containerId] = collectPanelIds(dock.getState().zones.center.layout)
    const container = useAppStore.getState().workspaces[0].panels[containerId]
    expect(container.type).toBe('container')
    expect(collectPanelIds(container.containerLayout)).toEqual(['a', 'b'])
    expect(collectPanelIds(dock.getState().zones.center.layout)).toEqual([containerId])
  })

  it('splits inside an existing container instead of the window', () => {
    const dock = setup()
    useAppStore.setState((s) => ({ workspaces: s.workspaces.map((w) => ({ ...w, panels: { ...w.panels, a: {
      ...w.panels.a, type: 'container', containerLayout: { type: 'tabs', id: 'inner', panelIds: [], activeIndex: 0 },
    } } })) }) as never)
    expect(splitByWrappingInContainer({
      workspaceId: 'ws', dockStoreApi: dock, stackId: 's1', edge: 'right',
      draggedPanelId: 'b', draggedPanelType: 'editor',
    })).toBe(true)
    const layout = useAppStore.getState().workspaces[0].panels.a.containerLayout!
    expect(layout.type).toBe('split')
    expect(collectPanelIds(layout)).toEqual(['b'])
    expect(collectPanelIds(dock.getState().zones.center.layout)).toEqual(['a'])
  })

  it('refuses to nest a dragged container', () => {
    const dock = setup()
    expect(splitByWrappingInContainer({
      workspaceId: 'ws', dockStoreApi: dock, stackId: 's1', edge: 'left',
      draggedPanelId: 'b', draggedPanelType: 'container',
    })).toBe(false)
  })
})
