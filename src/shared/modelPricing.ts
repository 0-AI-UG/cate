// =============================================================================
// Model pricing table — USD per 1 million tokens
// =============================================================================

import type { TokenCounts } from './types'

interface PriceEntry {
  /** Prefix to match against the model string (lower-case) */
  prefix: string
  /** Input tokens price per 1M */
  inP: number
  /** Output tokens price per 1M */
  outP: number
  /** Cache write tokens price per 1M */
  cwP: number
  /** Cache read tokens price per 1M */
  crP: number
}

const PRICING_TABLE: PriceEntry[] = [
  // Claude 4 family
  { prefix: 'claude-opus-4',    inP: 15,    outP: 75,   cwP: 18.75, crP: 1.50 },
  { prefix: 'claude-sonnet-4',  inP: 3,     outP: 15,   cwP: 3.75,  crP: 0.30 },
  { prefix: 'claude-haiku-4',   inP: 0.80,  outP: 4,    cwP: 1.00,  crP: 0.08 },
  // Claude 3.7 / 3.5 family
  { prefix: 'claude-opus-3',    inP: 15,    outP: 75,   cwP: 18.75, crP: 1.50 },
  { prefix: 'claude-sonnet-3',  inP: 3,     outP: 15,   cwP: 3.75,  crP: 0.30 },
  { prefix: 'claude-haiku-3',   inP: 0.80,  outP: 4,    cwP: 1.00,  crP: 0.08 },
  // OpenAI GPT-5 / GPT-4o family
  { prefix: 'gpt-5',            inP: 2.50,  outP: 10,   cwP: 0,     crP: 1.25 },
  { prefix: 'gpt-4o',           inP: 2.50,  outP: 10,   cwP: 0,     crP: 1.25 },
  { prefix: 'gpt-4-turbo',      inP: 10,    outP: 30,   cwP: 0,     crP: 0    },
  { prefix: 'gpt-4',            inP: 30,    outP: 60,   cwP: 0,     crP: 0    },
  { prefix: 'gpt-3.5',          inP: 0.50,  outP: 1.50, cwP: 0,     crP: 0    },
  // OpenAI o-series (reasoning)
  { prefix: 'o3-mini',          inP: 1.10,  outP: 4.40, cwP: 0,     crP: 0.55 },
  { prefix: 'o3',               inP: 10,    outP: 40,   cwP: 0,     crP: 2.50 },
  { prefix: 'o1-mini',          inP: 1.10,  outP: 4.40, cwP: 0,     crP: 0.55 },
  { prefix: 'o1',               inP: 15,    outP: 60,   cwP: 0,     crP: 7.50 },
  // Codex CLI model
  { prefix: 'codex-mini-latest', inP: 1.50, outP: 6,    cwP: 0,     crP: 0.375 },
  { prefix: 'codex',            inP: 1.50,  outP: 6,    cwP: 0,     crP: 0.375 },
]

/**
 * Price a token usage record for a given model.
 * Returns cost in USD, or null if the model is not in the pricing table.
 */
export function priceUsage(model: string, tokens: TokenCounts): number | null {
  const lower = model.toLowerCase()
  const entry = PRICING_TABLE.find((p) => lower.startsWith(p.prefix))
  if (!entry) return null
  return (
    tokens.input * entry.inP +
    tokens.output * entry.outP +
    tokens.cacheCreate * entry.cwP +
    tokens.cacheRead * entry.crP
  ) / 1_000_000
}
