// The layout tests run on fixture definitions; what they assert about chrome
// only holds if the fixtures carry the real definitions' chrome.

import { describe, expect, it } from 'vitest'
import { PANEL_DEFINITIONS } from '@panels/definitions'
import { testPanelDefinitions } from './clientWorkspace'

describe('testPanelDefinitions', () => {
  it('carry the chrome of the real panel definitions', () => {
    for (const fixture of testPanelDefinitions()) {
      const real = PANEL_DEFINITIONS.find((d) => d.type === fixture.type)
      expect(real, fixture.type).toBeDefined()
      expect(real!.chrome ?? {}, fixture.type).toEqual(fixture.chrome ?? {})
    }
  })
})
