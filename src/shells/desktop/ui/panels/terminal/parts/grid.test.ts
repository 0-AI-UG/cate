import { describe, expect, it } from 'vitest'
import { gridLayoutFor, sameGrid } from './grid'

describe('terminal grid', () => {
  it('scales a grid bigger than the panel down to it, keeping its shape', () => {
    expect(gridLayoutFor({ width: 1000, height: 400 }, { width: 500, height: 400 })).toEqual({ width: 1000, height: 400, scale: 0.5 })
    expect(gridLayoutFor({ width: 400, height: 800 }, { width: 500, height: 400 })).toEqual({ width: 400, height: 800, scale: 0.5 })
  })

  it('leaves a smaller grid at its size', () => {
    expect(gridLayoutFor({ width: 300, height: 200 }, { width: 500, height: 400 })).toEqual({ width: 300, height: 200, scale: 1 })
  })

  it('compares grids, null included', () => {
    expect(sameGrid({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(true)
    expect(sameGrid({ cols: 80, rows: 24 }, { cols: 80, rows: 25 })).toBe(false)
    expect(sameGrid({ cols: 80, rows: 24 }, null)).toBe(false)
  })
})
