import { useState } from 'react'
import { Check, Trash, Upload, Download as DownloadSimple, Sparkles as Sparkle } from 'lucide-react'
import { Tooltip } from '../ui/Tooltip'
import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, Select, NumberInput, TextInput, Toggle, SearchableBlock, SecondaryButton } from './SettingsComponents'
import type { Theme } from '../../shared/types'
import { validateTheme } from '../../shared/theme'
import { BUILT_IN_THEMES, DEFAULT_DARK_THEME_ID, DEFAULT_LIGHT_THEME_ID } from '../../shared/themes'
import { mergeThemeApp, resolveTheme } from '../../shared/themeResolution'
import { errorMessage } from '../lib/errorMessage'
import { InlineNotice } from '../ui/InlineNotice'

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

export function AppearanceSettings() {
  const store = useSettingsStore()
  const customThemes = store.customThemes ?? []
  const activeThemeId = store.activeThemeId
  const isSystem = activeThemeId === 'system'
  const [importError, setImportError] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

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
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id)
      return
    }
    store.setSetting('customThemes', customThemes.filter((t) => t.id !== id))
    if (activeThemeId === id) store.setSetting('activeThemeId', 'system')
    if (store.systemDarkThemeId === id) store.setSetting('systemDarkThemeId', DEFAULT_DARK_THEME_ID)
    if (store.systemLightThemeId === id) store.setSetting('systemLightThemeId', DEFAULT_LIGHT_THEME_ID)
    setConfirmDeleteId(null)
  }

  // Any theme can be used for either OS appearance — it's the user's choice.
  const themeOptions = allThemes.map((t) => ({ value: t.id, label: t.name }))

  return (
    <div className="flex flex-col gap-1">
      <SearchableBlock keywords={`theme appearance color dark light catalog import export system mode ${allThemes.map((theme) => theme.name).join(' ')}`}>
      {/* Mode + catalog header */}
      <div className="flex items-center justify-between py-2">
        <span className="text-[13px] font-medium text-primary">Theme</span>
        <SecondaryButton onClick={handleImport} title="Import a theme from a JSON file">
          <Upload size={11} />
          Import…
        </SecondaryButton>
      </div>

      {importError && <InlineNotice tone="error" className="mb-2 border-0 bg-transparent px-0">{importError}</InlineNotice>}

      {/* Catalog */}
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-2 pb-3 lg:grid-cols-3">
        <SystemCard
          active={isSystem}
          lightTheme={resolveTheme(store, 'system', false)}
          darkTheme={resolveTheme(store, 'system', true)}
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
            confirmingDelete={confirmDeleteId === theme.id}
          />
        ))}
      </div>

      {/* System light/dark mapping */}
      {isSystem && (
        <div className="mt-3 flex flex-col gap-1">
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
        className="mb-3 flex w-full items-center gap-2.5 rounded-lg border border-subtle bg-surface-2 px-3 py-2 text-left hover:bg-hover"
      >
        <div className="flex-shrink-0 flex items-center justify-center w-7 h-7 rounded-md bg-agent/15 text-focus-blue">
          <Sparkle size={14} />
        </div>
        <h4 className="text-xs font-medium text-primary">Create your own theme</h4>
      </button>
      </SearchableBlock>

      <SettingRow label="UI scale" description="Zooms Cate's interface; doesn't affect browser-panel pages">
        <Select
          value={String(store.uiScale)}
          onChange={(v) => store.setSetting('uiScale', parseFloat(v))}
          options={UI_SCALE_OPTIONS}
        />
      </SettingRow>

      <SettingRow label="Editor font size">
        <NumberInput value={store.editorFontSize} onChange={(v) => store.setSetting('editorFontSize', v)} min={8} max={32} step={1} />
      </SettingRow>

      <SettingRow label="Editor font family" description="Blank = default (Menlo, Monaco)">
        <TextInput
          value={store.editorFontFamily}
          onChange={(v) => store.setSetting('editorFontFamily', v)}
          placeholder="e.g., JetBrains Mono"
        />
      </SettingRow>

      <SearchableBlock keywords="gpu rasterization rendering glyph text missing garbled corruption render acceleration restart">
        <SettingRow
          label="Disable GPU text rendering"
          description="Fixes occasional missing or garbled glyphs by rasterizing text on the CPU. May slightly increase CPU use during canvas zoom. Takes effect after restarting Cate."
          hint={
            store.disableGpuRasterization ? (
              <span className="text-[11px] text-amber-400">Restart Cate for this to take effect.</span>
            ) : undefined
          }
        >
          <Toggle
            checked={store.disableGpuRasterization}
            onChange={(v) => store.setSetting('disableGpuRasterization', v)}
          />
        </SettingRow>
      </SearchableBlock>
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
