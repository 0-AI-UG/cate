import { useState } from 'react'
import { Check, Trash, Upload } from '@phosphor-icons/react'
import { useSettingsStore } from '../stores/settingsStore'
import { SettingRow, TextInput, NumberInput, Toggle } from './SettingsComponents'
import { TERMINAL_PRESETS } from '../lib/terminalRegistry'
import type { TerminalThemeData } from '../../shared/types'

/** Coerce arbitrary user JSON to a TerminalThemeData. Accepts either our exact
 *  shape or a partial xterm `{ name, ...colors }` flat object as a convenience. */
function parseImportedThemes(raw: unknown): TerminalThemeData[] {
  const list = Array.isArray(raw) ? raw : [raw]
  const out: TerminalThemeData[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, any>
    const theme = o.theme && typeof o.theme === 'object' ? o.theme : o
    if (typeof theme.background !== 'string' || typeof theme.foreground !== 'string') continue
    const label = String(o.label ?? o.name ?? 'Imported Theme').slice(0, 64)
    const id = String(o.id ?? label.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 64) || 'imported'
    out.push({
      id: `user-${id}-${Math.random().toString(36).slice(2, 6)}`,
      label,
      accent: String(o.accent ?? theme.cursor ?? theme.foreground ?? '#888'),
      theme: {
        background: theme.background,
        foreground: theme.foreground,
        cursor: theme.cursor,
        cursorAccent: theme.cursorAccent,
        selectionBackground: theme.selectionBackground,
        selectionForeground: theme.selectionForeground,
        black: theme.black,
        red: theme.red,
        green: theme.green,
        yellow: theme.yellow,
        blue: theme.blue,
        magenta: theme.magenta,
        cyan: theme.cyan,
        white: theme.white,
        brightBlack: theme.brightBlack,
        brightRed: theme.brightRed,
        brightGreen: theme.brightGreen,
        brightYellow: theme.brightYellow,
        brightBlue: theme.brightBlue,
        brightMagenta: theme.brightMagenta,
        brightCyan: theme.brightCyan,
        brightWhite: theme.brightWhite,
      },
    })
  }
  return out
}

export function TerminalSettings() {
  const store = useSettingsStore()
  const customThemes = store.terminalCustomThemes ?? []
  const [importError, setImportError] = useState<string | null>(null)

  const handleImport = async () => {
    setImportError(null)
    try {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.json,application/json'
      input.onchange = async () => {
        const file = input.files?.[0]
        if (!file) return
        try {
          const text = await file.text()
          const parsed = JSON.parse(text)
          const themes = parseImportedThemes(parsed)
          if (themes.length === 0) {
            setImportError('No valid theme found in file. Expected `{ label, theme: { background, foreground, ... } }`.')
            return
          }
          store.setSetting('terminalCustomThemes', [...customThemes, ...themes])
        } catch (err) {
          setImportError(err instanceof Error ? err.message : 'Failed to parse JSON')
        }
      }
      input.click()
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed')
    }
  }

  const handleDelete = (id: string) => {
    store.setSetting('terminalCustomThemes', customThemes.filter((t) => t.id !== id))
  }

  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs text-muted mb-3">
        Leave font fields blank to use system defaults.
      </p>
      <SettingRow label="Font family override">
        <TextInput
          value={store.terminalFontFamily}
          onChange={(v) => store.setSetting('terminalFontFamily', v)}
          placeholder="e.g., Menlo, Monaco"
        />
      </SettingRow>
      <SettingRow label="Font size override" description="0 = use default">
        <NumberInput
          value={store.terminalFontSize}
          onChange={(v) => store.setSetting('terminalFontSize', v)}
          min={0}
          max={32}
          step={1}
        />
      </SettingRow>
      <SettingRow
        label="Blink cursor"
        description="Off by default. A blinking cursor forces a GPU/compositor redraw on every blink, keeping the compositor awake even when the terminal is otherwise idle. A steady cursor stays fully visible."
      >
        <Toggle
          checked={store.terminalCursorBlink}
          onChange={(v) => store.setSetting('terminalCursorBlink', v)}
        />
      </SettingRow>
      <SettingRow
        label="Auto-suspend idle background terminals"
        description="Pause (SIGSTOP) terminals that have been offscreen and silent for 2 minutes so macOS can reclaim their memory. Resumes instantly on focus — no state loss. POSIX-only."
      >
        <Toggle
          checked={store.autoSuspendIdleTerminals}
          onChange={(v) => store.setSetting('autoSuspendIdleTerminals', v)}
        />
      </SettingRow>

      {/* Themes ---------------------------------------------------------- */}
      <div className="mt-5 pt-4 border-t border-subtle/40">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-xs font-medium text-primary">Themes</h4>
          <button
            onClick={handleImport}
            className="flex items-center gap-1.5 px-2 py-1 text-[11px] rounded text-secondary hover:text-primary bg-surface-2 hover:bg-hover border border-subtle"
            title="Import a theme from a JSON file"
          >
            <Upload size={11} />
            Import…
          </button>
        </div>
        <p className="text-[11px] text-muted mb-2">
          Click a row to set it as the default. New terminals (and any without
          an explicit theme) will use it. Per-terminal overrides via the tab's
          right-click menu still take precedence.
        </p>
        {importError && (
          <div className="text-[11px] text-red-400 mb-2">{importError}</div>
        )}

        <div className="flex flex-col gap-0.5">
          {/* "Follow app theme" — the implicit zero-state, surfaced as a
              clickable row so the user can revert to it. */}
          <ThemeRow
            label="Follow App Theme"
            description="Match the app's appearance"
            isDefault={!store.defaultTerminalTheme}
            onClick={() => store.setSetting('defaultTerminalTheme', '' as any)}
          />
          {TERMINAL_PRESETS.map((p) => (
            <ThemeRow
              key={p.id}
              label={p.label}
              swatch={p.theme.background}
              accent={p.accent}
              badge="built-in"
              isDefault={store.defaultTerminalTheme === p.id}
              onClick={() => store.setSetting('defaultTerminalTheme', p.id)}
            />
          ))}
          {customThemes.map((p) => (
            <ThemeRow
              key={p.id}
              label={p.label}
              swatch={p.theme.background}
              accent={p.accent}
              isDefault={store.defaultTerminalTheme === p.id}
              onClick={() => store.setSetting('defaultTerminalTheme', p.id)}
              onDelete={() => {
                handleDelete(p.id)
                if (store.defaultTerminalTheme === p.id) {
                  store.setSetting('defaultTerminalTheme', '' as any)
                }
              }}
            />
          ))}
          {customThemes.length === 0 && (
            <div className="text-[11px] text-muted px-2 py-1 italic">
              No imported themes yet.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

interface ThemeRowProps {
  label: string
  description?: string
  swatch?: string
  accent?: string
  badge?: string
  isDefault: boolean
  onClick: () => void
  onDelete?: () => void
}

function ThemeRow({ label, description, swatch, accent, badge, isDefault, onClick, onDelete }: ThemeRowProps) {
  return (
    <div
      onClick={onClick}
      className={`group flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
        isDefault ? 'bg-blue-500/10' : 'hover:bg-hover'
      }`}
      title={description ?? 'Click to set as default'}
    >
      <div
        className="w-4 h-4 rounded-sm border border-subtle flex-shrink-0"
        style={{ background: swatch ?? 'transparent' }}
      />
      <div
        className="w-3 h-3 rounded-full border border-subtle flex-shrink-0"
        style={{ background: accent ?? 'transparent' }}
      />
      <div className="flex flex-col min-w-0 flex-1">
        <span className="text-[12px] text-primary truncate">{label}</span>
        {description && (
          <span className="text-[10px] text-muted truncate">{description}</span>
        )}
      </div>
      {isDefault && (
        <span className="flex items-center gap-1 text-[10px] text-blue-400">
          <Check size={11} weight="bold" />
          Default
        </span>
      )}
      {badge && !isDefault && (
        <span className="text-[10px] text-muted">{badge}</span>
      )}
      {onDelete && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete() }}
          className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-muted hover:text-red-400 transition-opacity"
          title="Remove theme"
        >
          <Trash size={11} />
        </button>
      )}
    </div>
  )
}
