// @vitest-environment jsdom
//
// The Cate Agent must go completely quiet when no provider is connected.
// observeNow() is the cheapest observable entry point: with no observer session it
// warns when enabled, and must stay silent (early-return) when disabled.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cateAgentController } from './cateAgentController'

describe('cateAgentController provider gate', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
    cateAgentController.setEnabled(false)
  })

  it('observeNow is a no-op while disabled (no provider)', () => {
    cateAgentController.setEnabled(false)
    cateAgentController.observeNow('ws-without-session')
    expect(warn).not.toHaveBeenCalled()
  })

  it('observeNow runs (and warns about the missing session) once enabled', () => {
    cateAgentController.setEnabled(true)
    cateAgentController.observeNow('ws-without-session')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('observeNow: no observer session'),
      'ws-without-session',
    )
  })
})
