import { describe, it, expect } from 'vitest'
import { CATE_SENTINEL } from './cateControl'

describe('cateControl wire protocol', () => {
  it('exposes a stable sentinel string', () => {
    expect(CATE_SENTINEL).toBe('@@cate-control@@')
  })
})
