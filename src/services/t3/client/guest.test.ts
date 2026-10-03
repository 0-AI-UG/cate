import { describe, expect, it, vi } from 'vitest'
import { t3Conversations, t3ProductCopy } from './conversations'
import { t3ChangesScript, t3FileDropScript, t3SendTextScript } from './guest'

describe('guest scripts', () => {
  it('builds a valid guest drop that recreates the dragged image file', () => {
    const script = t3FileDropScript([{ name: 'screen.png', type: 'image/png', dataUrl: 'data:image/png;base64,AA==' }])
    expect(() => new Function(script)).not.toThrow()
    expect(script).toContain('new DataTransfer()')
    expect(script).toContain('screen.png')
    expect(script).toContain("dispatchEvent(new DragEvent('drop'")
  })

  it('escapes prompt text and change payloads', () => {
    expect(() => new Function(t3SendTextScript('say "hi"\n</script>'))).not.toThrow()
    const changes = t3ChangesScript({ threadId: 't', turns: { a: [{ path: 'x"y' }] } })
    expect(() => new Function(changes)).not.toThrow()
    expect(changes).toContain("new Event('cate-changes')")
  })
})

describe('conversation source', () => {
  it('lists newest first and addresses the checkout', async () => {
    const t3 = {
      conversations: vi.fn(async () => [
        { id: 'old', title: 'Old', updatedAt: '2026-01-01' },
        { id: 'new', title: 'New', updatedAt: '2026-02-01' },
      ]),
      renameConversation: vi.fn(async () => {}),
      deleteConversation: vi.fn(async () => {}),
    }
    const source = t3Conversations(t3, '/repo/feature')
    expect((await source.list()).map((thread) => thread.id)).toEqual(['new', 'old'])
    expect(t3.conversations).toHaveBeenCalledWith({ checkout: '/repo/feature' })
    await source.rename('new', 'Renamed')
    expect(t3.renameConversation).toHaveBeenCalledWith({ checkout: '/repo/feature', threadId: 'new', title: 'Renamed' })
    await source.remove('old')
    expect(t3.deleteConversation).toHaveBeenCalledWith({ checkout: '/repo/feature', threadId: 'old' })
  })

  it('normalizes product copy', () => {
    expect(t3ProductCopy('T3Code and T3 Code')).toBe('T3 Code and T3 Code')
  })
})
