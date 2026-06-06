import { useState } from 'react'
import { Check, Trash, Upload, DownloadSimple, Sparkle } from '@phosphor-icons/react'
import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, Select, NumberInput, SearchableBlock } from './SettingsComponents'
import type { Theme } from '../../shared/types'
import { validateTheme } from '../../shared/theme'
import { BASE_DARK, BASE_LIGHT, BUILT_IN_THEMES } from '../../shared/themes'
import { errorMessage } from '../lib/errorMessage'

const SKILL_GUIDE_URL = 'https://github.com/0-AI-UG/cate/blob/main/skills/cate-theme/SKILL.md'

/** Merge a theme's partial app map over its base — used for swatch previews. */
function appColors(theme: Theme): Record<string, string> {
  return { ...(theme.type === 'light' ? BASE_LIGHT : BASE_DARK), ...theme.app }
}

/** Resolve the surface-1 color of the theme currently mapped to a given OS
 *  appearance, so the System card preview matches the real selection (falls
 *  back to the generic base if the mapped theme can't be found). */
function systemSurface(themes: Theme[], id: string, side: 'light' | 'dark'): string {
  const theme = themes.find((t) => t.id === id)
  if (theme) return appColors(theme)['surface-1']
  return (side === 'light' ? BASE_LIGHT : BASE_DARK)['surface-1']
}

/** Ensure an id is unique against the existing theme list, suffixing -2, -3… */
function uniqueId(id: string, taken: Set<string>): string {
  if (!taken.has(id)) return id
  let n = 2
  while (taken.has(`${id}-${n}`)) n++
  return `${id}-${n}`
}

export function AppearanceSettings() {
  const store = useSettingsStore()
  const customThemes = store.customThemes ?? []
  const activeThemeId = store.activeThemeId
  const isSystem = activeThemeId === 'system'
  const [importError, setImportError] = useState<string | null>(null)

  const allThemes: Theme[] = [...BUILT_IN_THEMES, ...customThemes]

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
          store.setSetting('customThemes', [...customThemes, ...valid])
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
    store.setSetting('customThemes', customThemes.filter((t) => t.id !== id))
    if (activeThemeId === id) store.setSetting('activeThemeId', 'system')
    if (store.systemDarkThemeId === id) store.setSetting('systemDarkThemeId', 'dark-warm')
    if (store.systemLightThemeId === id) store.setSetting('systemLightThemeId', 'light-subtle')
  }

  // Any theme can be used for either OS appearance — it's the user's choice.
  const themeOptions = allThemes.map((t) => ({ value: t.id, label: t.name }))

  return (
    <div className="flex flex-col gap-1">
      <SearchableBlock keywords="theme appearance color dark light catalog import export system mode">
      {/* Mode + catalog header */}
      <div className="flex items-center justify-between py-2.5">
        <span className="text-sm text-primary">Theme</span>
        <button
          onClick={handleImport}
          className="flex items-center gap-1.5 px-2 py-1 text-[11px] rounded text-secondary hover:text-primary bg-surface-2 hover:bg-hover border border-subtle"
          title="Import a theme from a JSON file"
        >
          <Upload size={11} />
          Import…
        </button>
      </div>

      {importError && <div className="text-[11px] text-red-400 mb-2">{importError}</div>}

      {/* Catalog */}
      <div className="grid grid-cols-2 gap-2">
        <SystemCard
          active={isSystem}
          lightColor={systemSurface(allThemes, store.systemLightThemeId, 'light')}
          darkColor={systemSurface(allThemes, store.systemDarkThemeId, 'dark')}
          onClick={() => store.setSetting('activeThemeId', 'system')}
        />
        {allThemes.map((theme) => (
          <ThemeCard
            key={theme.id}
            theme={theme}
            active={!isSystem && activeThemeId === theme.id}
            onClick={() => store.setSetting('activeThemeId', theme.id)}
            onExport={() => handleExport(theme)}
            onDelete={theme.builtIn ? undefined : () => handleDelete(theme.id)}
          />
        ))}
      </div>

      {/* System light/dark mapping */}
      {isSystem && (
        <div className="mt-3 flex flex-col gap-1 rounded-lg border border-subtle px-3 py-2">
          <p className="text-[11px] text-muted mb-1">
            Follows your OS appearance, switching between the two themes below.
          </p>
          <SettingRow label="Light appearance">
            <Select
              value={store.systemLightThemeId}
              onChange={(v) => store.setSetting('systemLightThemeId', v)}
              options={themeOptions}
            />
          </SettingRow>
          <SettingRow label="Dark appearance">
            <Select
              value={store.systemDarkThemeId}
              onChange={(v) => store.setSetting('systemDarkThemeId', v)}
              options={themeOptions}
            />
          </SettingRow>
        </div>
      )}

      {/* Create / get more themes */}
      <button
        onClick={() => window.electronAPI?.openExternalUrl(SKILL_GUIDE_URL)}
        className="mt-4 flex w-full items-center gap-3 rounded-xl border border-subtle bg-surface-2 px-3.5 py-3 text-left hover:bg-surface-1"
      >
        <div className="flex-shrink-0 flex items-center justify-center w-8 h-8 rounded-lg bg-agent/15 text-focus-blue">
          <Sparkle size={16} weight="fill" />
        </div>
        <h4 className="text-[13px] font-semibold text-primary">Create your own theme</h4>
      </button>
      </SearchableBlock>

      <SettingRow label="Editor font size">
        <NumberInput value={store.editorFontSize} onChange={(v) => store.setSetting('editorFontSize', v)} min={8} max={32} step={1} />
      </SettingRow>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Cards
// -----------------------------------------------------------------------------

function CardShell({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <div
      onClick={onClick}
      className={`group relative flex flex-col gap-2 p-2 rounded-lg border cursor-pointer transition-colors ${
        active ? 'border-focus-blue bg-agent/10' : 'border-subtle hover:bg-hover'
      }`}
    >
      {children}
      {active && (
        <span className="absolute top-1.5 right-1.5 text-focus-blue">
          <Check size={13} weight="bold" />
        </span>
      )}
    </div>
  )
}

function SwatchPreview({ theme }: { theme: Theme }) {
  const c = appColors(theme)
  const ansi = [theme.terminal.red, theme.terminal.green, theme.terminal.yellow, theme.terminal.blue, theme.terminal.magenta, theme.terminal.cyan]
  return (
    <div
      className="h-12 rounded-md border border-subtle overflow-hidden flex flex-col justify-between p-1.5"
      style={{ background: c['surface-1'] }}
    >
      <div className="flex items-center gap-1">
        <span className="text-[10px] font-medium" style={{ color: c['text-primary'] }}>Aa</span>
        <span className="w-2 h-2 rounded-full" style={{ background: c['focus-blue'] }} />
        <span className="text-[9px]" style={{ color: c['text-muted'] }}>code</span>
      </div>
      <div className="flex gap-0.5">
        {ansi.map((color, i) => (
          <span key={i} className="h-1.5 flex-1 rounded-sm" style={{ background: color }} />
        ))}
      </div>
    </div>
  )
}

function ThemeCard({
  theme, active, onClick, onExport, onDelete,
}: {
  theme: Theme
  active: boolean
  onClick: () => void
  onExport: () => void
  onDelete?: () => void
}) {
  return (
    <CardShell active={active} onClick={onClick}>
      <SwatchPreview theme={theme} />
      <div className="flex items-center justify-between min-w-0">
        <span className="text-[12px] text-primary truncate">{theme.name}</span>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); onExport() }}
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-muted hover:text-primary transition-opacity"
            title="Export theme"
          >
            <DownloadSimple size={12} />
          </button>
          {onDelete ? (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete() }}
              className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-muted hover:text-red-400 transition-opacity"
              title="Remove theme"
            >
              <Trash size={12} />
            </button>
          ) : (
            <span className="text-[10px] text-muted">built-in</span>
          )}
        </div>
      </div>
    </CardShell>
  )
}

function SystemCard({
  active, lightColor, darkColor, onClick,
}: { active: boolean; lightColor: string; darkColor: string; onClick: () => void }) {
  return (
    <CardShell active={active} onClick={onClick}>
      <div className="h-12 rounded-md border border-subtle overflow-hidden flex">
        <div className="flex-1" style={{ background: lightColor }} />
        <div className="flex-1" style={{ background: darkColor }} />
      </div>
      <span className="text-[12px] text-primary truncate">System</span>
    </CardShell>
  )
}
