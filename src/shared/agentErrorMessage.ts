const SAFE_PREFIXES = [
  'Cate couldn’t',
  'The Cate agent',
  'The selected model',
  'The model provider',
  'This chat',
]

function rawMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message
  }
  return ''
}

/** Convert agent/runtime failures into bounded user-facing copy. Technical
 * details stay in logs; unknown messages are never echoed into the chat UI. */
export function agentErrorMessage(
  error: unknown,
  fallback = 'The Cate agent ran into a problem. Try again.',
): string {
  const message = rawMessage(error).trim()
  if (!message) return fallback
  if (!message.includes('\n') && SAFE_PREFIXES.some((prefix) => message.startsWith(prefix))) {
    return message
  }
  if (/failed to load extension|extension runtime not initialized|extension[_\s-]error/i.test(message)) {
    return 'Cate couldn’t load its agent tools. Restart Cate and start a new chat.'
  }
  if (/agent process exited|pi process exited|agent exited/i.test(message)) {
    return 'The Cate agent stopped unexpectedly. Start a new chat and try again.'
  }
  if (/authentication|unauthorized|invalid api key|HTTP 401|HTTP 403/i.test(message)) {
    return 'The selected model couldn’t authenticate. Check its provider connection.'
  }
  if (/rate.?limit|too many requests|HTTP 429/i.test(message)) {
    return 'The model provider is rate-limiting requests. Wait a moment and try again.'
  }
  if (/model not supported|unknown model|model .* not found/i.test(message)) {
    return 'The selected model is unavailable. Choose another model and try again.'
  }
  if (/context length|context window|too many tokens|maximum context/i.test(message)) {
    return 'This chat exceeded the model’s context limit. Compact it or start a new chat.'
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network|socket hang up|fetch failed/i.test(message)) {
    return 'Cate couldn’t reach the model provider. Check your connection and try again.'
  }
  return fallback
}
