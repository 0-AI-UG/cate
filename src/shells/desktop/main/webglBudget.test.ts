import { describe, expect, it } from 'vitest'
import { createWebglBudget } from './webglBudget'

describe('webgl budget', () => {
  it('grants up to the cap across windows, idempotently, and reclaims a window', () => {
    const budget = createWebglBudget(3)
    expect(budget.request(1, 'a')).toBe(true)
    expect(budget.request(1, 'a')).toBe(true)
    expect(budget.request(2, 'b')).toBe(true)
    expect(budget.request(2, 'c')).toBe(true)
    expect(budget.request(3, 'd')).toBe(false)
    budget.release(2, 'c')
    expect(budget.request(3, 'd')).toBe(true)
    budget.reclaim(1)
    expect(budget.count()).toBe(2)
  })
})
