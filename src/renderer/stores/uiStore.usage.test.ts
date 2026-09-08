import { afterEach, expect, it } from 'vitest'
import { useUIStore } from './uiStore'

afterEach(() => {
  useUIStore.getState().setShowUsage(false)
  useUIStore.getState().closeSettings()
})

it('switches between usage and settings without overlapping full-page views', () => {
  useUIStore.getState().openSettings('t3 code')
  useUIStore.getState().setShowUsage(true)
  expect(useUIStore.getState()).toMatchObject({ showUsage: true, showSettings: false, settingsInitialTab: null })
  useUIStore.getState().openSettings()
  expect(useUIStore.getState()).toMatchObject({ showUsage: false, showSettings: true })
})

it('returns from usage without changing sidebar preferences', () => {
  const before = useUIStore.getState()
  useUIStore.getState().setShowUsage(true)
  useUIStore.getState().setShowUsage(false)
  expect(useUIStore.getState()).toMatchObject({
    showUsage: false,
    leftSidebarHidden: before.leftSidebarHidden,
  })
})

it('keeps Skills, Usage, and Settings mutually exclusive', () => {
  const ui = useUIStore.getState()
  ui.setShowUsage(true)
  ui.setShowSkillsDialog(true)
  expect(useUIStore.getState()).toMatchObject({ showSkillsDialog: true, showUsage: false, showSettings: false })
  ui.openSettings('skills')
  expect(useUIStore.getState()).toMatchObject({ showSkillsDialog: false, showUsage: false, showSettings: true })
  ui.setShowSkillsDialog(true)
  ui.setShowUsage(true)
  expect(useUIStore.getState()).toMatchObject({ showSkillsDialog: false, showUsage: true, showSettings: false })
})

it('keeps pull requests exclusive with the other full-page views', () => {
  const ui = useUIStore.getState()
  ui.setShowSkillsDialog(true)
  ui.setShowPullRequests(true)
  expect(useUIStore.getState()).toMatchObject({ showPullRequests: true, showSkillsDialog: false, showUsage: false, showSettings: false })
  ui.setShowUsage(true)
  expect(useUIStore.getState().showPullRequests).toBe(false)
  ui.setShowPullRequests(true)
  ui.openSettings()
  expect(useUIStore.getState().showPullRequests).toBe(false)
  ui.setShowPullRequests(true)
  ui.setShowSkillsDialog(true)
  expect(useUIStore.getState().showPullRequests).toBe(false)
  ui.setShowSkillsDialog(false)
})
