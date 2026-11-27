// The interface languages and their translations. English is the source: a
// text is looked up by its English form and falls back to it when a language
// has no entry yet, so untranslated parts of the UI stay in English instead of
// breaking. `{name}` placeholders are filled from `vars`. Pure.

import { PT_BR } from './locales/ptBR'

export const LANGUAGES = [
  { id: 'en', name: 'English', region: 'United States', flag: 'us' },
  { id: 'pt-BR', name: 'Português', region: 'Brasil', flag: 'br' },
] as const

export type Language = (typeof LANGUAGES)[number]['id']
export type LanguageFlag = (typeof LANGUAGES)[number]['flag']

export const LANGUAGE_IDS = LANGUAGES.map((l) => l.id) as unknown as readonly Language[]

const DICTIONARIES: Readonly<Record<Language, Readonly<Record<string, string>> | null>> = {
  en: null,
  'pt-BR': PT_BR,
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGE_IDS as readonly string[]).includes(value)
}

/** `text` (English) in `language`, with `{name}` placeholders filled. */
export function translate(language: Language, text: string, vars?: Readonly<Record<string, string | number>>): string {
  const out = DICTIONARIES[language]?.[text] ?? text
  return vars ? out.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match)) : out
}
