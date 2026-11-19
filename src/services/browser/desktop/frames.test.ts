import { expect, it } from 'vitest'
import { FrameTree } from './frames'

it('finds the session a frame lives in through the frames holding it', () => {
  const frames = new FrameTree()
  expect(frames.record({ frame: { id: 'main' }, childFrames: [{ frame: { id: 'oopif' }, childFrames: [{ frame: { id: 'inner' } }] }] })).toEqual(['main', 'oopif', 'inner'])
  frames.attachSession('oopif', 's1')
  expect(frames.sessionOf('main')).toBeUndefined()
  expect(frames.sessionOf('inner')).toBe('s1')
  expect(frames.ownSession('inner')).toBeUndefined()
  frames.drop('oopif')
  expect(frames.frameOfSession('s1')).toBeUndefined()
  expect(frames.sessionIds()).toEqual([])
})

it('keeps the parent of an out-of-process target whose tree starts at that child', () => {
  const frames = new FrameTree()
  frames.record({ frame: { id: 'main' } })
  frames.attachSession('login', 's1')
  frames.record({ frame: { id: 'login', parentId: 'main' } })
  frames.record({ frame: { id: 'login' } })
  expect(frames.parent('login')).toBe('main')
  expect(frames.sessionOf(frames.parent('login'))).toBeUndefined()
})
