// React access to the interface language (kernel/interaction's `language`
// setting): `useT()` returns a translator that re-renders on a change.

import { useCallback } from 'react'
import { translate } from '@kernel/interaction/contract'
import { getClientSetting, useClientSetting } from './index'

export type Translate = (text: string, vars?: Readonly<Record<string, string | number>>) => string

export function useT(): Translate {
  const language = useClientSetting('language')
  return useCallback<Translate>((text, vars) => translate(language, text, vars), [language])
}

/** Outside React: translates with the language set now. */
export function t(text: string, vars?: Readonly<Record<string, string | number>>): string {
  return translate(getClientSetting('language'), text, vars)
}

interface MenuEntry { label?: string; submenu?: MenuEntry[] }

/** A context menu's labels in the interface language, at the one place
 *  every menu passes on its way to the native menu. */
export function translateMenu<T extends MenuEntry>(items: T[]): T[] {
  return items.map((item) => ({
    ...item,
    ...(item.label ? { label: t(item.label) } : {}),
    ...(item.submenu ? { submenu: translateMenu(item.submenu) } : {}),
  }))
}
