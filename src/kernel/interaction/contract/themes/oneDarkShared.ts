// =============================================================================
// Shared One Dark Pro Monaco token rules.
//
// The standard One Dark Pro token palette is identical across the One Dark Pro,
// Flat, and Darker variants, so it lives here as a single source of truth. The
// Vivid variant uses a more saturated palette derived from the same rules with a
// handful of foreground swaps (see ONE_DARK_VIVID_TOKENS).
// =============================================================================

import type { EditorTokenColor } from '../theme'

/** Standard One Dark Pro syntax token rules (Pro / Flat / Darker). */
export const ONE_DARK_TOKENS: EditorTokenColor[] = [
  { token: 'comment', foreground: '7f848e', fontStyle: 'italic' },
  { token: 'keyword', foreground: 'c678dd' },
  { token: 'keyword.control', foreground: 'c678dd' },
  { token: 'storage', foreground: 'c678dd' },
  { token: 'storage.type', foreground: 'c678dd' },
  { token: 'string', foreground: '98c379' },
  { token: 'constant.numeric', foreground: 'd19a66' },
  { token: 'constant.language', foreground: 'd19a66' },
  { token: 'constant', foreground: '56b6c2' },
  { token: 'variable', foreground: 'e06c75' },
  { token: 'variable.parameter', foreground: 'abb2bf' },
  { token: 'type', foreground: 'e5c07b' },
  { token: 'entity.name.type', foreground: 'e5c07b' },
  { token: 'entity.name.class', foreground: 'e5c07b' },
  { token: 'entity.name.function', foreground: '61afef' },
  { token: 'support.function', foreground: '61afef' },
  { token: 'entity.name.tag', foreground: 'e06c75' },
  { token: 'entity.other.attribute-name', foreground: 'd19a66' },
  { token: 'operator', foreground: '56b6c2' },
]

/** Vivid foreground overrides keyed by token scope. The Vivid variant is the
 *  standard palette with these more saturated swaps applied. */
const ONE_DARK_VIVID_OVERRIDES: Record<string, string> = {
  keyword: 'd55fde',
  'keyword.control': 'd55fde',
  storage: 'd55fde',
  'storage.type': 'd55fde',
  string: '89ca78',
  constant: '2bbac5',
  variable: 'ef596f',
  'entity.name.tag': 'ef596f',
  operator: '2bbac5',
}

/** Vivid One Dark Pro syntax token rules — the standard rules with the saturated
 *  foreground swaps applied, preserving rule order. */
export const ONE_DARK_VIVID_TOKENS: EditorTokenColor[] = ONE_DARK_TOKENS.map((rule) =>
  ONE_DARK_VIVID_OVERRIDES[rule.token]
    ? { ...rule, foreground: ONE_DARK_VIVID_OVERRIDES[rule.token] }
    : rule,
)
