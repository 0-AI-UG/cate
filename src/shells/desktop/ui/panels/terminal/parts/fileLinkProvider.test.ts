import { expect, it, vi } from 'vitest'
import type { ILink } from '@xterm/xterm'
import { createFileLinkProvider } from './fileLinkProvider'

const terminal = (lines: string[]) => ({
  buffer: { active: { getLine: (y: number) => (lines[y] === undefined ? undefined : { translateToString: () => lines[y] }) } },
})

it('links existing files relative to the terminal cwd and opens them at their line', async () => {
  const isFile = vi.fn(async (path: string) => path === '/repo/src/a.ts')
  const open = vi.fn()
  const provider = createFileLinkProvider(terminal(['error in src/a.ts:12:5 and lib/missing.ts']), { base: () => '/repo', isFile, open }, true)
  const links = await new Promise<ILink[] | undefined>((resolve) => provider.provideLinks(1, resolve))
  expect(links).toHaveLength(1)
  expect(links![0].text).toBe('src/a.ts:12:5')
  expect(links![0].range).toEqual({ start: { x: 10, y: 1 }, end: { x: 22, y: 1 } })
  links![0].activate({ metaKey: false, ctrlKey: true } as MouseEvent, links![0].text)
  expect(open).not.toHaveBeenCalled()
  links![0].activate({ metaKey: true, ctrlKey: false } as MouseEvent, links![0].text)
  expect(open).toHaveBeenCalledWith('/repo/src/a.ts', 12, 5)
  // Existence is asked once per path.
  await new Promise((resolve) => provider.provideLinks(1, resolve))
  expect(isFile).toHaveBeenCalledTimes(2)
})
