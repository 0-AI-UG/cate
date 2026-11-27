import { describe, expect, it } from 'vitest'
import { isLanguage, translate } from './i18n'

describe('translate', () => {
  it('returns the English text for English', () => {
    expect(translate('en', 'Settings')).toBe('Settings')
  })

  it('translates a known text', () => {
    expect(translate('pt-BR', 'Settings')).toBe('Configurações')
  })

  it('falls back to English for a text with no translation', () => {
    expect(translate('pt-BR', 'Not in any dictionary')).toBe('Not in any dictionary')
  })

  it('fills placeholders after translating', () => {
    expect(translate('pt-BR', 'No settings match “{query}”.', { query: 'tema' })).toBe('Nenhuma configuração corresponde a “tema”.')
    expect(translate('en', 'Theme {n}: {error}', { n: 2, error: 'bad' })).toBe('Theme 2: bad')
  })

  it('knows its languages', () => {
    expect(isLanguage('pt-BR')).toBe(true)
    expect(isLanguage('fr')).toBe(false)
  })
})
