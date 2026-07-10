import { describe, expect, it } from 'vitest'
import { agentMessageText, lastAssistantMessage, lastAssistantText } from './agentMessages'

describe('agent message helpers', () => {
  it('joins only text content blocks and trims the result', () => {
    expect(agentMessageText({
      content: [
        { type: 'text', text: ' first ' },
        { type: 'image', data: 'ignored' },
        { type: 'text', text: 'second ' },
      ],
    })).toBe('first second')
    expect(agentMessageText(null)).toBe('')
  })

  it('selects the newest assistant containing text, falling back to the newest assistant', () => {
    const olderWithText = { role: 'assistant', content: [{ type: 'text', text: 'answer' }] }
    const newestEmpty = { role: 'assistant', content: [{ type: 'toolCall' }] }
    const messages = [olderWithText, { role: 'user', content: [] }, newestEmpty]

    expect(lastAssistantMessage(messages)).toBe(olderWithText)
    expect(lastAssistantText(messages)).toBe('answer')
    expect(lastAssistantMessage([newestEmpty])).toBe(newestEmpty)
    expect(lastAssistantMessage('invalid')).toBeNull()
  })
})
