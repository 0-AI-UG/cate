/** Normalize harness-owned UI copy. Never apply to user content or configuration. */
export function agentProductCopy(text: string): string {
  return text.replace(/\bT3(?: Code|Code)?\b/g, 'Cate Agent')
}
