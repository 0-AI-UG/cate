// Appearance page (kernel/ui's appearance slice): theme catalog, system
// light/dark mapping, custom theme import/export and UI scale. Editor fonts
// moved to the Editor page, GPU rasterization to the desktop shell's page.

import { useState, type ReactNode } from 'react'
import { Check, Trash, Upload, Download as DownloadSimple, Sparkles as Sparkle } from 'lucide-react'
import {
  InlineNotice,
  SearchableBlock,
  SecondaryButton,
  Select,
  SettingRow,
  Tooltip,
  clientUi,
  errorMessage,
} from '@kernel/ui'
import {
  BUILT_IN_THEMES,
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  mergeThemeApp,
  resolveTheme,
  validateTheme,
  type Theme,
} from '@kernel/ui/contract'
import { setClientSetting, useClientSetting } from '@kernel/settings/ui'

const SKILL_GUIDE_URL = 'https://github.com/0-AI-UG/cate/blob/main/skills/cate-theme/SKILL.md'

const UI_SCALE_OPTIONS = [0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5].map((s) => ({
  value: String(s),
  label: `${Math.round(s * 100)}%`,
}))

/** Ensure an id is unique against the existing theme list, suffixing -2, -3… */
function uniqueId(id: string, taken: Set<string>): string {
  if (!taken.has(id)) return id
  let n = 2
  while (taken.has(`${id}-${n}`)) n++
  return `${id}-${n}`
}

export function AppearancePage(): JSX.Element {
  const customThemes = useClientSetting('customThemes')
  const activeThemeId = useClientSetting('activeThemeId')
  const systemLightThemeId = useClientSetting('systemLightThemeId')
  const systemDarkThemeId = useClientSetting('systemDarkThemeId')
  const uiScale = useClientSetting('uiScale')
  const isSystem = activeThemeId === 'system'
  const [importError, setImportError] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const allThemes: Theme[] = [...BUILT_IN_THEMES, ...customThemes]
  const themeSettings = { customThemes, systemLightThemeId, systemDarkThemeId }

  const handleImport = () => {
    setImportError(null)
    try {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.json,application/json'
      input.onchange = async () => {
        const file = input.files?.[0]
        if (!file) return
        try {
          const parsed = JSON.parse(await file.text())
          const list = Array.isArray(parsed) ? parsed : [parsed]
          const taken = new Set(allThemes.map((t) => t.id))
          const valid: Theme[] = []
          for (let i = 0; i < list.length; i++) {
            const res = validateTheme(list[i])
            if (!res.ok) {
              setImportError(list.length > 1 ? `Theme ${i + 1}: ${res.error}` : res.error)
              if (list.length === 1) return
              continue
            }
            const t = res.theme
            t.id = uniqueId(t.id, taken)
            t.builtIn = false
            taken.add(t.id)
            valid.push(t)
          }
          if (valid.length === 0) return
          setClientSetting('customThemes', [...customThemes, ...valid])
        } catch (err) {
          setImportError(errorMessage(err, 'Failed to parse JSON'))
        }
      }
      input.click()
    } catch (err) {
      setImportError(errorMessage(err, 'Import failed'))
    }
  }

  const handleExport = (theme: Theme) => {
    const { builtIn: _builtIn, ...exported } = theme
    const blob = new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${theme.id}.cate-theme.json`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const handleDelete = (id: string) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id)
      return
    }
    setClientSetting('customThemes', customThemes.filter((t) => t.id !== id))
    if (activeThemeId === id) setClientSetting('activeThemeId', 'system')
    if (systemDarkThemeId === id) setClientSetting('systemDarkThemeId', DEFAULT_DARK_THEME_ID)
    if (systemLightThemeId === id) setClientSetting('systemLightThemeId', DEFAULT_LIGHT_THEME_ID)
    setConfirmDeleteId(null)
  }

  // Any theme can be used for either OS appearance.
  const themeOptions = allThemes.map((t) => ({ value: t.id, label: t.name }))

  return (
    <div className="flex flex-col gap-1">
      <SearchableBlock keywords={`theme appearance color dark light catalog import export system mode ${allThemes.map((theme) => theme.name).join(' ')}`}>
      <div className="flex items-center justify-between py-2">
        <span className="text-[13px] font-medium text-primary">Theme</span>
        <SecondaryButton onClick={handleImport} title="Import a theme from a JSON file">
          <Upload size={11} />
          Import…
        </SecondaryButton>
      </div>

      {importError && <InlineNotice tone="error" className="mb-2 border-0 bg-transparent px-0">{importError}</InlineNotice>}

      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-2 pb-3 lg:grid-cols-3">
        <SystemCard
          active={isSystem}
          lightTheme={resolveTheme(themeSettings, 'system', false)}
          darkTheme={resolveTheme(themeSettings, 'system', true)}
          onClick={() => setClientSetting('activeThemeId', 'system')}
        />
        {allThemes.map((theme) => (
          <ThemeCard
            key={theme.id}
            theme={theme}
            active={!isSystem && activeThemeId === theme.id}
            onClick={() => setClientSetting('activeThemeId', theme.id)}
            onExport={() => handleExport(theme)}
            onDelete={theme.builtIn ? undefined : () => handleDelete(theme.id)}
            confirmingDelete={confirmDeleteId === theme.id}
          />
        ))}
      </div>

      {isSystem && (
        <div className="mt-3 flex flex-col gap-1">
          <p className="text-[11px] text-muted mb-1">
            Follows your OS appearance, switching between the two themes below.
          </p>
          <SettingRow label="Light appearance">
            <Select value={systemLightThemeId} onChange={(v) => setClientSetting('systemLightThemeId', v)} options={themeOptions} />
          </SettingRow>
          <SettingRow label="Dark appearance">
            <Select value={systemDarkThemeId} onChange={(v) => setClientSetting('systemDarkThemeId', v)} options={themeOptions} />
          </SettingRow>
        </div>
      )}

      <button
        onClick={() => clientUi().openExternal(SKILL_GUIDE_URL)}
        className="mb-3 flex w-full items-center gap-2.5 rounded-lg border border-subtle bg-surface-2 px-3 py-2 text-left hover:bg-hover"
      >
        <div className="flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-md bg-agent/15 text-focus-blue">
          <Sparkle size={14} />
        </div>
        <h4 className="text-xs font-medium text-primary">Create your own theme</h4>
      </button>
      </SearchableBlock>

      <SettingRow label="UI scale" description="Zooms Cate's interface; doesn't affect browser-panel pages">
        <Select value={String(uiScale)} onChange={(v) => setClientSetting('uiScale', parseFloat(v))} options={UI_SCALE_OPTIONS} />
      </SettingRow>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Cards
// -----------------------------------------------------------------------------

function CardShell({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <div
      role="radio"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onClick()
        }
      }}
      aria-checked={active}
      className={`group relative flex min-h-[124px] flex-col justify-between rounded-xl border p-3 text-left cursor-pointer transition-colors ${
        active ? 'border-focus-blue bg-agent/10' : 'border-subtle hover:bg-hover'
      }`}
    >
      {children}
      {active && (
        <span className="absolute top-1.5 right-1.5 text-focus-blue">
          <Check size={13} />
        </span>
      )}
    </div>
  )
}

function SwatchPreview({ theme }: { theme: Theme }) {
  const c = mergeThemeApp(theme)
  return (
    <div className="flex items-center justify-center gap-5 py-1">
      <ThemeOrb base={c['surface-1']} shade={c['surface-6']} accent={c['focus-blue']} />
      <ThemeOrb base={c['canvas-bg-alt']} shade={c['surface-4']} accent={c['focus-blue']} reverse />
    </div>
  )
}

function ThemeOrb({
  base,
  shade,
  accent,
  reverse = false,
}: {
  base: string
  shade: string
  accent: string
  reverse?: boolean
}) {
  const softenedAccent = `color-mix(in srgb, ${accent} 22%, ${base})`
  const softenedShade = `color-mix(in srgb, ${shade} 72%, ${base})`
  return (
    <span
      className="h-14 w-14 rounded-full border border-white/10 shadow-[0_5px_16px_rgba(0,0,0,0.28)]"
      style={{
        backgroundColor: base,
        backgroundImage: reverse
          ? `radial-gradient(circle at 70% 72%, ${softenedShade} 0, transparent 62%), radial-gradient(circle at 24% 20%, ${softenedAccent} 0, transparent 48%)`
          : `radial-gradient(circle at 30% 72%, ${softenedShade} 0, transparent 62%), radial-gradient(circle at 76% 20%, ${softenedAccent} 0, transparent 48%)`,
      }}
    />
  )
}

function ThemeCard({
  theme, active, onClick, onExport, onDelete, confirmingDelete,
}: {
  theme: Theme
  active: boolean
  onClick: () => void
  onExport: () => void
  onDelete?: () => void
  confirmingDelete?: boolean
}) {
  return (
    <CardShell active={active} onClick={onClick}>
      <SwatchPreview theme={theme} />
      <div className="flex items-center justify-between min-w-0">
        <span className="text-[12px] text-primary truncate">{theme.name}</span>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Tooltip label="Export theme">
            <button
              onClick={(e) => { e.stopPropagation(); onExport() }}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded-lg text-muted hover:text-primary transition-opacity"
              aria-label="Export theme"
            >
              <DownloadSimple size={12} />
            </button>
          </Tooltip>
          {onDelete ? (
            <Tooltip label={confirmingDelete ? 'Confirm removal' : 'Remove theme'}>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete() }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded-lg text-muted hover:text-red-400 transition-opacity"
                aria-label={confirmingDelete ? 'Confirm removal' : 'Remove theme'}
              >
                <Trash size={12} />
              </button>
            </Tooltip>
          ) : (
            <span className="text-[10px] text-muted">built-in</span>
          )}
        </div>
      </div>
    </CardShell>
  )
}

function SystemCard({
  active, lightTheme, darkTheme, onClick,
}: { active: boolean; lightTheme: Theme; darkTheme: Theme; onClick: () => void }) {
  const light = mergeThemeApp(lightTheme)
  const dark = mergeThemeApp(darkTheme)
  return (
    <CardShell active={active} onClick={onClick}>
      <div className="flex items-center justify-center gap-5 py-1">
        <ThemeOrb base={light['surface-1']} shade={light['surface-6']} accent={light['focus-blue']} />
        <ThemeOrb base={dark['surface-1']} shade={dark['surface-6']} accent={dark['focus-blue']} reverse />
      </div>
      <span className="text-[12px] text-primary truncate">System</span>
    </CardShell>
  )
}
