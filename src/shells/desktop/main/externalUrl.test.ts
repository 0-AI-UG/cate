import { expect, it } from 'vitest'
import { externalUrl } from './externalUrl'

it('opens web and mail links outside Cate, never a loopback page', () => {
  expect(externalUrl('https://github.com/0-AI-UG/cate')).toBe('https://github.com/0-AI-UG/cate')
  expect(externalUrl('mailto:team@example.com')).toBe('mailto:team@example.com')
  // A loopback page belongs to the runtime's machine: it opens in Cate (D10).
  expect(() => externalUrl('http://127.0.0.1:5173/')).toThrow()
  expect(() => externalUrl('http://localhost:3000/app')).toThrow()
  expect(() => externalUrl('http://[::1]:8080')).toThrow()
  expect(() => externalUrl('file:///etc/passwd')).toThrow()
  expect(() => externalUrl(42)).toThrow()
})
