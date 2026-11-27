// Language page (kernel/interaction's `language` setting): one card per
// interface language, with its country's flag. Flags are drawn as SVG
// because Windows has no flag emoji.

import { Check } from 'lucide-react'
import { LANGUAGES, type LanguageFlag } from '@kernel/interaction/contract'
import { SearchableBlock } from '../../../kernel/interaction'
import { setClientSetting, useClientSetting, useT } from '../../../kernel/settings'

export function LanguagePage(): JSX.Element {
  const language = useClientSetting('language')
  const t = useT()
  return (
    <SearchableBlock keywords={`language idioma língua lingua locale translation tradução ${LANGUAGES.map((l) => `${l.name} ${l.region}`).join(' ')}`}>
      <div className="py-2">
        <p className="text-[13px] font-medium text-primary">{t('Language')}</p>
        <p className="text-[11px] text-muted mt-0.5">{t('The language of Cate’s interface on this device.')}</p>
      </div>
      <div role="radiogroup" aria-label={t('Language')} className="grid grid-cols-2 gap-2 pb-2 lg:grid-cols-3">
        {LANGUAGES.map((option) => {
          const active = option.id === language
          return (
            <button
              type="button"
              role="radio"
              key={option.id}
              aria-checked={active}
              onClick={() => setClientSetting('language', option.id)}
              className={`relative flex items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                active ? 'border-focus-blue bg-agent/10' : 'border-subtle hover:bg-hover'
              }`}
            >
              <Flag flag={option.flag} />
              <span className="flex min-w-0 flex-col">
                <span className="text-[13px] font-medium text-primary truncate">{option.name}</span>
                <span className="text-[11px] text-muted truncate">{option.region}</span>
              </span>
              {active && <Check size={13} className="absolute top-1.5 right-1.5 text-focus-blue" />}
            </button>
          )
        })}
      </div>
      {language !== 'en' && <p className="text-[11px] text-muted pb-2">{t('Parts of the interface not translated yet stay in English.')}</p>}
    </SearchableBlock>
  )
}

function Flag({ flag }: { flag: LanguageFlag }): JSX.Element {
  return (
    <span className="flex h-6 w-9 flex-shrink-0 overflow-hidden rounded-[3px] shadow-[0_0_0_1px_rgba(0,0,0,0.15)]" aria-hidden>
      {flag === 'br' ? <BrazilFlag /> : <UsFlag />}
    </span>
  )
}

function BrazilFlag(): JSX.Element {
  return (
    <svg viewBox="0 0 30 20" className="h-full w-full">
      <rect width="30" height="20" fill="#009C3B" />
      <polygon points="15,2 28,10 15,18 2,10" fill="#FFDF00" />
      <circle cx="15" cy="10" r="4.4" fill="#002776" />
      <path d="M10.7 9.2 Q15 8 19.3 10.6" stroke="#fff" strokeWidth="0.8" fill="none" />
    </svg>
  )
}

function UsFlag(): JSX.Element {
  const stripes = Array.from({ length: 13 }, (_, i) => i)
  return (
    <svg viewBox="0 0 38 20" preserveAspectRatio="none" className="h-full w-full">
      {stripes.map((i) => (
        <rect key={i} y={(i * 20) / 13} width="38" height={20 / 13 + 0.05} fill={i % 2 === 0 ? '#B22234' : '#fff'} />
      ))}
      <rect width="15.2" height={(20 * 7) / 13} fill="#3C3B6E" />
      {[0, 1, 2, 3, 4].flatMap((row) =>
        [0, 1, 2, 3, 4, 5].slice(0, row % 2 ? 5 : 6).map((col) => (
          <circle key={`${row}-${col}`} cx={1.3 + col * 2.5 + (row % 2) * 1.25} cy={1.3 + row * 2.3} r="0.45" fill="#fff" />
        )),
      )}
    </svg>
  )
}
