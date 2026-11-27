// The text panel's record: its words (`NOTE_TEXT_FIELD`, shared with the
// note) and how they look (colour, size, weight, family) are record fields,
// so they are document state next to the node rect that gives the box its
// place and size. Pure.

import type { PanelRecord } from '@workspace/document/contract'

/** The record field holding a text block's colour (one of `TEXT_COLORS`). */
export const TEXT_COLOR_FIELD = 'color'
/** The record field holding a text block's font size, in canvas pixels. */
export const TEXT_SIZE_FIELD = 'fontSize'
/** The record field holding a text block's weight (one of `TEXT_WEIGHTS`). */
export const TEXT_WEIGHT_FIELD = 'fontWeight'
/** The record field holding a text block's family (one of `TEXT_FAMILIES`). */
export const TEXT_FAMILY_FIELD = 'fontFamily'

/** The colours a text block can take; `default` is the theme's text colour. */
export const TEXT_COLORS = ['default', 'red', 'blue', 'green', 'yellow', 'purple'] as const
export type TextColor = (typeof TEXT_COLORS)[number]

export const TEXT_WEIGHTS = ['regular', 'medium', 'bold'] as const
export type TextWeight = (typeof TEXT_WEIGHTS)[number]

export const TEXT_FAMILIES = ['sans', 'serif', 'mono'] as const
export type TextFamily = (typeof TEXT_FAMILIES)[number]

export const TEXT_SIZE_DEFAULT = 24
export const TEXT_SIZE_MIN = 8
export const TEXT_SIZE_MAX = 160
/** One press of the size buttons. */
export const TEXT_SIZE_STEP = 2

export interface TextStyle {
  color: TextColor
  size: number
  weight: TextWeight
  family: TextFamily
}

export const DEFAULT_TEXT_STYLE: TextStyle = { color: 'default', size: TEXT_SIZE_DEFAULT, weight: 'regular', family: 'mono' }

function oneOf<T extends string>(options: readonly T[], value: unknown, fallback: T): T {
  return (options as readonly unknown[]).includes(value) ? value as T : fallback
}

/** A size kept within the allowed range, whole pixels. */
export function clampTextSize(size: number): number {
  return Math.min(TEXT_SIZE_MAX, Math.max(TEXT_SIZE_MIN, Math.round(size)))
}

/** A text block's look; the default for a missing or unknown value. */
export function textStyle(record: PanelRecord): TextStyle {
  const f = record.fields
  const size = f[TEXT_SIZE_FIELD]
  return {
    color: oneOf(TEXT_COLORS, f[TEXT_COLOR_FIELD], DEFAULT_TEXT_STYLE.color),
    size: typeof size === 'number' && Number.isFinite(size) ? clampTextSize(size) : DEFAULT_TEXT_STYLE.size,
    weight: oneOf(TEXT_WEIGHTS, f[TEXT_WEIGHT_FIELD], DEFAULT_TEXT_STYLE.weight),
    family: oneOf(TEXT_FAMILIES, f[TEXT_FAMILY_FIELD], DEFAULT_TEXT_STYLE.family),
  }
}
