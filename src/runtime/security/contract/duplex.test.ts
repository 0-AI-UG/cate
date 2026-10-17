import { describe, expect, it, vi } from 'vitest'
import type { SecureChannel } from './channel'
import { secureChannelDuplex } from './duplex'

describe('secureChannelDuplex', () => {
  it('drops writes once the channel closed instead of throwing at the writer', () => {
    const channel = {
      closed: true,
      send: vi.fn(() => { throw new Error('channel closed') }),
      onFrame: () => () => {},
      onClose: () => () => {},
      close: () => {},
    } as unknown as SecureChannel
    expect(() => secureChannelDuplex(channel).write(new Uint8Array([1]))).not.toThrow()
    expect(channel.send).not.toHaveBeenCalled()
  })
})
