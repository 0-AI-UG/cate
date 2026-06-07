import { useCallback } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { t as tBase, type StringKey } from '../i18n/strings'

export function useTranslation() {
  const lang = useSettingsStore((s) => s.language) ?? 'ko'
  const t = useCallback((key: StringKey) => tBase(key, lang), [lang])
  return { t, lang }
}
