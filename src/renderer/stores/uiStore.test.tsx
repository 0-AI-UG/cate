import { describe, expect, it } from 'vitest'
import { useUIStore } from './uiStore'

describe('left sidebar visibility', () => {
  it('setLeftSidebarHidden and toggleLeftSidebar flip the hidden flag', () => {
    useUIStore.getState().setLeftSidebarHidden(true)
    expect(useUIStore.getState().leftSidebarHidden).toBe(true)
    useUIStore.getState().toggleLeftSidebar()
    expect(useUIStore.getState().leftSidebarHidden).toBe(false)
  })

  it('toggleSidebar switches directly between hidden and maximized', () => {
    useUIStore.setState({ leftSidebarHidden: true })
    useUIStore.getState().toggleSidebar()
    expect(useUIStore.getState().leftSidebarHidden).toBe(false)
    useUIStore.getState().toggleSidebar()
    expect(useUIStore.getState().leftSidebarHidden).toBe(true)
  })
})
