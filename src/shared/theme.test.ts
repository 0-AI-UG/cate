import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { validateTheme, APP_COLOR_KEYS, TERMINAL_ANSI_KEYS } from './theme'
import { BUILT_IN_THEMES } from './themes'

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
    const res = validateTheme({
      id: 'evil',
      name: 'Evil',
      type: 'dark',
      app: { 'surface-0': 'red; background: url(http://x)', 'surface-1': '#112233' },
      terminal: { background: '#000000', foreground: '#ffffff' },
      editor: { base: 'vs-dark', tokens: [] },
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.theme.app['surface-0']).toBeUndefined() // rejected
      expect(res.theme.app['surface-1']).toBe('#112233') // kept
    }
  })

  it('fills missing ANSI colors from defaults', () => {
    const res = validateTheme({
      id: 'partial',
      name: 'Partial',
      type: 'dark',
      terminal: { background: '#101010', foreground: '#e0e0e0' },
      editor: { base: 'vs-dark', tokens: [] },
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.theme.terminal.red).toBeTruthy()
  })
})
