import { describe, expect, it } from 'vitest'
import { browserLocatorOf, describeBrowserLocator, matchBrowserElements } from './locator'

const elements = [
  { id: 1, role: 'button', name: 'Save draft' },
  { id: 2, role: 'button', name: 'Save' },
  { id: 3, role: 'link', name: 'Saved  items' },
  { id: 4, role: 'textbox', name: 'Email' },
]

describe('browser locators', () => {
  it('match role in any case and a name they contain in any case', () => {
    expect(matchBrowserElements(elements, { role: 'Button', name: 'save' }).map((e) => e.id)).toEqual([1, 2])
    expect(matchBrowserElements(elements, { name: 'saved items' }).map((e) => e.id)).toEqual([3])
    expect(matchBrowserElements(elements, { role: 'textbox' }).map((e) => e.id)).toEqual([4])
  })

  it('match the whole name, same case, when exact', () => {
    expect(matchBrowserElements(elements, { role: 'button', name: 'Save', exact: true }).map((e) => e.id)).toEqual([2])
    expect(matchBrowserElements(elements, { name: 'save', exact: true })).toEqual([])
  })

  it('come from call arguments and read back for errors', () => {
    expect(browserLocatorOf({ target: 3 })).toBeUndefined()
    expect(browserLocatorOf({ role: 'button', name: 'Save', exact: true })).toEqual({ role: 'button', name: 'Save', exact: true })
    expect(describeBrowserLocator({ role: 'button', name: 'Save' })).toBe('role=button name~"Save"')
    expect(describeBrowserLocator({ name: 'Save', exact: true })).toBe('name="Save"')
  })
})
