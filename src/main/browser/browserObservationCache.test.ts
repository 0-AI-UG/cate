import { expect, it } from 'vitest'
import type { BrowserObservation } from '../../shared/browserAutomation'
import { BrowserObservationCache } from './browserObservationCache'

const observation = (id: string): BrowserObservation => ({
  panelId: 'p', tabId: 't', observationId: id, documentId: 'd', kind: 'ax',
  url: 'https://example.test', title: 'Example', state: 'diff', diff: true,
  viewport: { width: 800, height: 600, zoom: 1, deviceScaleFactor: 2, scrollX: 0, scrollY: 0 },
  elements: [{ id: 7, role: 'textbox', name: 'Name', value: 'large value', states: { focused: true } }],
  screenshot: { mimeType: 'image/png', data: 'large image', width: 800, height: 600 },
})

it('retains only full diff state and element authority, independent of returned objects', () => {
  const cache = new BrowserObservationCache()
  const source = observation('one')
  cache.set(source, 'full state')
  source.elements[0].id = 9
  source.viewport.scrollY = 40
  const cached = cache.get('one')!
  expect(cached).toMatchObject({ state: 'full state', focusedElementId: 7, viewport: { scrollY: 0 } })
  expect([...cached.elementIds]).toEqual([7])
  expect(cached).not.toHaveProperty('elements')
  expect(cached).not.toHaveProperty('screenshot')
  expect(cached).not.toHaveProperty('url')
})

it('evicts by retained-byte budget and promotes a still-used AX baseline', () => {
  const cache = new BrowserObservationCache(900)
  cache.set(observation('one'), 'one')
  cache.set(observation('two'), 'two')
  cache.get('one')
  cache.set(observation('three'), 'three')
  expect(cache.get('two')).toBeUndefined()
  expect(cache.get('one')).toBeDefined()
  expect(cache.get('three')).toBeDefined()
  expect(cache.estimatedBytes).toBeLessThanOrEqual(900)
  cache.clear()
  expect(cache.size).toBe(0)
  expect(cache.estimatedBytes).toBe(0)
})

it('rejects an oversized observation without discarding an existing valid baseline', () => {
  const cache = new BrowserObservationCache(900)
  cache.set(observation('one'), 'one')
  expect(() => cache.set(observation('large'), 'x'.repeat(1000))).toThrow('browser-observation-too-large')
  expect(cache.get('one')).toBeDefined()
})
