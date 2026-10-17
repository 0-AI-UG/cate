// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { holdFocus } from './holdFocus'

describe('holdFocus', () => {
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('takes focus back from the element a click moved it to, while owned', () => {
    vi.useFakeTimers()
    const target = document.createElement('textarea')
    const other = document.createElement('button')
    document.body.append(target, other)
    const stop = holdFocus(() => target, () => true)
    expect(document.activeElement).toBe(target)
    other.focus()
    vi.advanceTimersByTime(25)
    expect(document.activeElement).toBe(target)
    stop()
    other.focus()
    vi.advanceTimersByTime(100)
    expect(document.activeElement).toBe(other)
  })

  it('waits for the element to attach and stops once focus moves elsewhere', () => {
    vi.useFakeTimers()
    const target = document.createElement('textarea')
    const other = document.createElement('button')
    document.body.append(other)
    let owned = true
    holdFocus(() => target, () => owned)
    vi.advanceTimersByTime(50)
    document.body.append(target)
    vi.advanceTimersByTime(25)
    expect(document.activeElement).toBe(target)
    owned = false
    other.focus()
    vi.advanceTimersByTime(100)
    expect(document.activeElement).toBe(other)
  })

  it('takes focus from a text field that had it at the start, and stops for one that takes it later', () => {
    vi.useFakeTimers()
    const target = document.createElement('textarea')
    const urlBar = document.createElement('input')
    const rename = document.createElement('input')
    document.body.append(target, urlBar, rename)
    urlBar.focus()
    holdFocus(() => target, () => true)
    expect(document.activeElement).toBe(target)
    rename.focus()
    vi.advanceTimersByTime(100)
    expect(document.activeElement).toBe(rename)
  })
})
