import { expect, it, vi } from 'vitest'
import { createMobileLinks } from './links'

it('holds the question until the app answers, and a newer one cancels it', async () => {
  const links = createMobileLinks()
  const changed = vi.fn()
  links.subscribe(changed)
  const first = links.ask('https://a.example')
  expect(links.prompt()).toEqual({ url: 'https://a.example' })
  const second = links.ask('https://b.example')
  expect(await first).toBe('cancel')
  expect(links.prompt()).toEqual({ url: 'https://b.example' })
  links.answer('cate')
  expect(await second).toBe('cate')
  expect(links.prompt()).toBeNull()
  expect(changed).toHaveBeenCalledTimes(3)
})
