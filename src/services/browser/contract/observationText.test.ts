import { describe, expect, it } from 'vitest'
import { browserRecovery, browserStateWithin, describeBrowserObservation, diffBrowserState } from './observationText'
import type { BrowserObservation } from './automation'

describe('browserStateWithin', () => {
  const state = [
    '- navigation "Kursindex" [id=3]',
    '  - link "Topic 1" [id=4]',
    '- main [id=5]',
    '  - heading "Exercise 1" [id=6]',
    '    - StaticText "Exercise 1" [id=7]',
    '  - link "exercise_1.pdf" [id=8]',
    '- link "Impressum" [id=9]',
  ].join('\n')

  it('keeps an element and what is nested under it, de-indented', () => {
    expect(browserStateWithin(state, 5)).toBe([
      '- main [id=5]',
      '  - heading "Exercise 1" [id=6]',
      '    - StaticText "Exercise 1" [id=7]',
      '  - link "exercise_1.pdf" [id=8]',
    ].join('\n'))
    expect(browserStateWithin(state, 6)).toBe('- heading "Exercise 1" [id=6]\n  - StaticText "Exercise 1" [id=7]')
  })

  it('does not take id 1 for id 10 and reports a missing element', () => {
    expect(browserStateWithin(state, 1)).toBeNull()
  })
})

describe('diffBrowserState', () => {
  it('shows changed lines under the ancestors that locate them', () => {
    const before = ['- main [id=1]', '  - form "Login" [id=2]', '    - button "Sign in" [id=3]', '- contentinfo [id=9]'].join('\n')
    const after = ['- main [id=1]', '  - form "Login" [id=2]', '    - button "Sign in" [disabled] [id=3]', '    - StaticText "Signing in" [id=4]', '- contentinfo [id=9]'].join('\n')
    expect(diffBrowserState(before, after)).toBe([
      '  - main [id=1]',
      '    - form "Login" [id=2]',
      '-     - button "Sign in" [id=3]',
      '  - main [id=1]',
      '    - form "Login" [id=2]',
      '+     - button "Sign in" [disabled] [id=3]',
      '+     - StaticText "Signing in" [id=4]',
    ].join('\n'))
    expect(diffBrowserState(before, before)).toBe('No changes.')
  })
})

describe('browserRecovery', () => {
  it('gives each failure its own next step and warns only once input was sent', () => {
    expect(browserRecovery('element-obscured: covered by <div#consent>', false)).toMatch(/^Another element covers the target/)
    expect(browserRecovery('element-obscured: covered by <div#consent>', true)).toMatch(/Input was already sent/)
    expect(browserRecovery('browser-option-values-required', false)).toBeUndefined()
    expect(browserRecovery('invalid-browser-scroll', false)).toBeUndefined()
    expect(browserRecovery('browser-point-outside-viewport', false)).toMatch(/^That point is outside the viewport/)
    expect(browserRecovery('element-outside-viewport', false)).toMatch(/outside the viewport after scrolling/)
    expect(browserRecovery('something-new', false)).toBe('Observe the tab again before retrying.')
  })
})

describe('describeBrowserObservation', () => {
  const observation = (patch: Partial<BrowserObservation> = {}): BrowserObservation => ({
    panelId: 'p', tabId: 't', kind: 'ax', observationId: 'o1', documentId: 'd1', url: 'https://example.test/', title: 'Example',
    viewport: { width: 800, height: 600, zoom: 1, deviceScaleFactor: 2, scrollX: 0, scrollY: 0, scrollWidth: 800, scrollHeight: 600 }, state: '- button "Save" [id=1]', elements: [], diff: false, ...patch,
  })

  it('reads as plain text: outcome, page, then the tree or its changes', () => {
    expect(describeBrowserObservation(observation(), { method: 'click', status: 'dispatched' }))
      .toBe('click: dispatched\nPage: Example (https://example.test/)\n- button "Save" [id=1]')
    expect(describeBrowserObservation(observation({ diff: true, state: 'No changes.', viewport: { ...observation().viewport, scrollY: 240, scrollHeight: 2680 } })))
      .toBe('Page: Example (https://example.test/)\nViewport 800x600 at 0,240 of a 800x2680 page (240px above, 1840px below)\nChanges since the last observation:\nNo changes.')
  })

  it('says how much of the page lies past each edge of the viewport', () => {
    const header = (patch: Partial<BrowserObservation['viewport']>) =>
      describeBrowserObservation(observation({ viewport: { ...observation().viewport, ...patch } })).split('\n')[1]
    expect(header({ scrollWidth: 1200, scrollHeight: 3000 })).toBe('Viewport 800x600 at 0,0 of a 1200x3000 page (2400px below, 400px right)')
    expect(header({ scrollWidth: 785, scrollHeight: 585 })).toBe('- button "Save" [id=1]')
    expect(header({ scrollY: 2400, scrollHeight: 2985 })).toBe('Viewport 800x600 at 0,2400 of a 800x2985 page (2400px above)')
  })

  it('says why a requested screenshot is missing', () => {
    expect(describeBrowserObservation(observation({ screenshotError: 'browser-page-hidden' }))).toContain('No screenshot (browser-page-hidden): The browser panel is not on screen')
  })
})
