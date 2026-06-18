import { beforeEach, describe, expect, test } from 'vitest'
import { useBrowserStore } from './browserStore'

beforeEach(() => {
  useBrowserStore.setState({
    history: [
      { url: 'https://github.com', title: 'GitHub', lastVisited: 2, visitCount: 5 },
      { url: 'https://example.com', title: 'Example', lastVisited: 1, visitCount: 1 },
    ],
    bookmarks: [{ url: 'https://github.com', title: 'GitHub', addedAt: 1 }],
  })
})

describe('browserStore selectors', () => {
  test('isBookmarked reflects current bookmarks', () => {
    expect(useBrowserStore.getState().isBookmarked('https://github.com')).toBe(true)
    expect(useBrowserStore.getState().isBookmarked('https://example.com')).toBe(false)
  })

  test('querySuggestions filters by url/title and respects limit', () => {
    const r = useBrowserStore.getState().querySuggestions('git', 5)
    expect(r.map((e) => e.url)).toEqual(['https://github.com'])
    expect(useBrowserStore.getState().querySuggestions('', 1)).toHaveLength(1)
  })
})
