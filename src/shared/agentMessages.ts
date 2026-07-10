/** Concatenate the text blocks of one pi message. */
export function agentMessageText(message: unknown): string {
  const content = (message as { content?: unknown } | null)?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: 'text'; text: string } =>
      !!part &&
      (part as { type?: string }).type === 'text' &&
      typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('')
    .trim()
}

/** Most recent assistant message with text, falling back to the last assistant. */
export function lastAssistantMessage(messages: unknown): Record<string, unknown> | null {
  if (!Array.isArray(messages)) return null
  let lastAssistant: Record<string, unknown> | null = null
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string } | null
    if (message?.role !== 'assistant') continue
    const record = message as Record<string, unknown>
    if (!lastAssistant) lastAssistant = record
    if (agentMessageText(message)) return record
  }
  return lastAssistant
}

export function lastAssistantText(messages: unknown): string {
  return agentMessageText(lastAssistantMessage(messages))
}
