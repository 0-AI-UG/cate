import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { validateTheme, APP_COLOR_KEYS, TERMINAL_ANSI_KEYS, THEME_SCHEMA_VERSION } from './theme'
import type { Theme } from './theme'
import { BUILT_IN_THEMES, BASE_DARK, BASE_LIGHT } from './themes'

// ---- WCAG contrast helpers (kept local; the app has no color lib) ----------
type RGB = { r: number; g: number; b: number; a: number }
function parseColor(v: string): RGB | null {
  const s = v.trim()
  const hexM = /^#([0-9a-fA-F]{3,8})$/.exec(s)
  if (hexM) {
    let h = hexM[1]
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('')
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    }
  }
  const rgbM = /^rgba?\(([^)]+)\)$/.exec(s)
  if (rgbM) {
    const p = rgbM[1].split(/[,/]/).map((x) => parseFloat(x.trim()))
    return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }
  }
  return null
}
function over(fg: RGB, bg: RGB): RGB {
  const a = fg.a
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 }
}
function luminance(c: RGB): number {
  const f = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
}
function contrast(a: RGB, b: RGB): number {
  const l1 = luminance(a); const l2 = luminance(b)
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
}
function mergedApp(t: Theme): Record<string, string> {
  return { ...(t.type === 'dark' ? BASE_DARK : BASE_LIGHT), ...t.app }
}
/** Contrast of a possibly-translucent `fgKey` over an opaque `bgKey`. */
function ratio(app: Record<string, string>, fgKey: string, bgKey: string): number {
  const fg = parseColor(app[fgKey])!
  const bgRaw = parseColor(app[bgKey])!
  const bg = bgRaw.a < 1 ? over(bgRaw, parseColor(app['surface-0'])!) : bgRaw
  return contrast(over(fg, bg), bg)
}

const SKILL_DIR = path.join(process.cwd(), 'skills', 'cate-theme')

describe('built-in themes', () => {
  for (const t of BUILT_IN_THEMES) {
    it(`${t.id} has the full terminal palette + a boot background`, () => {
      expect(t.terminal.background).toBeTruthy()
      expect(t.terminal.foreground).toBeTruthy()
      for (const k of TERMINAL_ANSI_KEYS) {
        expect(typeof t.terminal[k], `${t.id}.terminal.${k}`).toBe('string')
      }
      expect(t.bootBackground, `${t.id}.bootBackground`).toBeTruthy()
    })

    it(`${t.id} round-trips through validateTheme`, () => {
      const res = validateTheme(JSON.parse(JSON.stringify(t)))
      expect(res.ok).toBe(true)
    })
  }

  it('all built-in ids are unique', () => {
    const ids = BUILT_IN_THEMES.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

// Guards against a theme shipping washed-out chrome or an illegible terminal.
// Floors are a touch below the values the themes are tuned to, so a genuine
// regression trips the test but rounding noise does not.
describe('built-in theme contrast', () => {
  for (const t of BUILT_IN_THEMES) {
    const app = mergedApp(t)
    const termBg = parseColor(t.terminal.background)!

    it(`${t.id}: body & secondary text meet WCAG AA`, () => {
      expect(ratio(app, 'text-primary', 'surface-1')).toBeGreaterThanOrEqual(4.5)
      expect(ratio(app, 'text-primary', 'surface-0')).toBeGreaterThanOrEqual(4.5)
      expect(ratio(app, 'text-secondary', 'surface-1')).toBeGreaterThanOrEqual(4.4)
    })

    it(`${t.id}: muted text stays legible`, () => {
      // Muted text can appear on the hover surface (surface-2), the harder bg.
      expect(ratio(app, 'text-muted', 'surface-2')).toBeGreaterThanOrEqual(2.95)
    })

    it(`${t.id}: panel borders are visible against surfaces`, () => {
      expect(ratio(app, 'border-strong', 'surface-1')).toBeGreaterThanOrEqual(1.3)
    })

    it(`${t.id}: readable ANSI colors are legible on the terminal background`, () => {
      // The commonly-printed foreground colors. `black` is the intentional dark
      // anchor (~1:1 by design) and the remaining bright variants are lighter
      // than their base, so this subset is what must clear the legibility floor.
      const READABLE = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightBlue'] as const
      for (const k of READABLE) {
        const fg = parseColor(t.terminal[k])!
        expect(
          contrast(over(fg, termBg), termBg),
          `${t.id}.terminal.${k}`,
        ).toBeGreaterThanOrEqual(2.9)
      }
    })
  }
})

describe('cate-theme skill schema parity', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'theme.schema.json'), 'utf-8'))

  it('schema app properties exactly match APP_COLOR_KEYS', () => {
    const schemaKeys = Object.keys(schema.properties.app.properties).sort()
    expect(schemaKeys).toEqual([...APP_COLOR_KEYS].sort())
  })

  it('schema requires every terminal ANSI key', () => {
    for (const k of TERMINAL_ANSI_KEYS) {
      expect(schema.properties.terminal.required).toContain(k)
    }
  })
})

describe('bundled example themes', () => {
  const dir = path.join(SKILL_DIR, 'examples')
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    it(`${file} passes validateTheme`, () => {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'))
      const res = validateTheme(raw)
      expect(res.ok, res.ok ? '' : (res as { error: string }).error).toBe(true)
    })
  }
})

describe('validateTheme', () => {
  it('rejects a non-object', () => {
    expect(validateTheme(null).ok).toBe(false)
    expect(validateTheme('nope').ok).toBe(false)
  })

  it('rejects a theme with no terminal palette', () => {
    expect(validateTheme({ id: 'x', name: 'X', type: 'dark' }).ok).toBe(false)
  })

  it('strips CSS-injection attempts from app values', () => {
    const terminal = BUILT_IN_THEMES[0].terminal
    const res = validateTheme({
      version: THEME_SCHEMA_VERSION,
      id: 'evil',
      name: 'Evil',
      type: 'dark',
      app: { 'surface-0': 'red; background: url(http://x)', 'surface-1': '#112233' },
      terminal,
      editor: { base: 'vs-dark', tokens: [] },
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.theme.app['surface-0']).toBeUndefined() // rejected
      expect(res.theme.app['surface-1']).toBe('#112233') // kept
    }
  })

  it('keeps a custom canvas wallpaper scrim override', () => {
    const current = BUILT_IN_THEMES[0]
    const res = validateTheme({
      ...current,
      id: 'custom-wallpaper',
      app: { 'canvas-backdrop-scrim': 'rgba(255, 255, 255, 0)' },
    })

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.theme.app['canvas-backdrop-scrim']).toBe('rgba(255, 255, 255, 0)')
    }
  })

  it('rejects imports without the current schema version', () => {
    const current = BUILT_IN_THEMES[0]
    expect(validateTheme({ ...current, version: undefined }).ok).toBe(false)
    expect(validateTheme({ ...current, version: THEME_SCHEMA_VERSION - 1 }).ok).toBe(false)
  })

  it('rejects incomplete terminal palettes', () => {
    const res = validateTheme({
      version: THEME_SCHEMA_VERSION,
      id: 'partial',
      name: 'Partial',
      type: 'dark',
      terminal: { background: '#101010', foreground: '#e0e0e0' },
      editor: { base: 'vs-dark', tokens: [] },
    })
    expect(res.ok).toBe(false)
  })

  it('rejects legacy aliases for canonical fields', () => {
    const current = BUILT_IN_THEMES[0]
    const { name: _name, type: _type, ...rest } = current
    expect(validateTheme({ ...rest, label: 'Legacy', kind: 'dark' }).ok).toBe(false)
  })
})
