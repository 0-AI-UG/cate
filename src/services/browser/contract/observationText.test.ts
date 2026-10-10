import { describe, expect, it } from 'vitest'
import { browserRecovery, describeBrowserObservation, diffBrowserState } from './observationText'
import type { BrowserObservation } from './automation'

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
    expect(browserRecovery('something-new', false)).toBe('Observe the tab again before retrying.')
  })
})

describe('describeBrowserObservation', () => {
  const observation = (patch: Partial<BrowserObservation> = {}): BrowserObservation => ({
    panelId: 'p', tabId: 't', kind: 'ax', observationId: 'o1', documentId: 'd1', url: 'https://example.test/', title: 'Example',
    viewport: { width: 800, height: 600, zoom: 1, deviceScaleFactor: 2, scrollX: 0, scrollY: 0 }, state: '- button "Save" [id=1]', elements: [], diff: false, ...patch,
  })

  it('reads as plain text: outcome, page, then the tree or its changes', () => {
    expect(describeBrowserObservation(observation(), { method: 'click', status: 'dispatched' }))
      .toBe('click: dispatched\nPage: Example (https://example.test/)\n- button "Save" [id=1]')
    expect(describeBrowserObservation(observation({ diff: true, state: 'No changes.', viewport: { width: 800, height: 600, zoom: 1, deviceScaleFactor: 2, scrollX: 0, scrollY: 240 } })))
      .toBe('Page: Example (https://example.test/)\nScrolled to 0,240 in a 800x600 viewport\nChanges since the last observation:\nNo changes.')
  })

  it('says why a requested screenshot is missing', () => {
    expect(describeBrowserObservation(observation({ screenshotError: 'browser-page-hidden' }))).toContain('No screenshot (browser-page-hidden): The browser panel is not on screen')
  })
})
