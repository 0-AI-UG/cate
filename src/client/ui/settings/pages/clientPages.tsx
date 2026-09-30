// Small pages: client/ui's own slices (Sidebar, Notifications) and the pages
// of slices whose owners have no page of their own yet (Editor from
// panels/editor, Terminal from services/terminal, Browser from
// services/browser). Workspace keys show
// only while a workspace is active.

import { useEffect, useState } from 'react'
import { NumberInput, SecondaryButton, Select, SettingRow, Slider, TextInput, Toggle, errorMessage } from '@kernel/ui'
import type { WorkspaceSettingKey, WorkspaceSettings, ClientSettings } from '@kernel/settings/contract'
import {
  setClientSetting,
  setWorkspaceSetting,
  useClientSetting,
  useWorkspaceSettings,
} from '@kernel/settings/ui'
import { tryRuntimeFor } from '@kernel/rpc/client'
import type { SettingsPageProps } from '../registry'

function setWs<K extends WorkspaceSettingKey>(workspaceId: string, key: K, value: WorkspaceSettings[K]): void {
  void setWorkspaceSetting(workspaceId, key, value).catch(() => { /* the mirror reverts */ })
}

export function SidebarPage(): JSX.Element {
  const onLaunch = useClientSetting('showFileExplorerOnLaunch')
  const skills = useClientSetting('showSkillsInWorkspaceOverview')
  const tint = useClientSetting('sidebarTintOpacity')
  return (
    <div className="flex flex-col gap-1">
      <SettingRow label="Show file explorer on launch">
        <Toggle checked={onLaunch} onChange={(v) => setClientSetting('showFileExplorerOnLaunch', v)} />
      </SettingRow>
      <SettingRow label="Show skills in workspace overview" description="List installed agent skills beneath expanded workspaces.">
        <Toggle checked={skills} onChange={(v) => setClientSetting('showSkillsInWorkspaceOverview', v)} />
      </SettingRow>
      <SettingRow label="Sidebar background opacity" description={`${Math.round(tint * 100)}%`}>
        <Slider value={tint} onChange={(v) => setClientSetting('sidebarTintOpacity', v)} min={0.3} max={1.0} step={0.05} />
      </SettingRow>
    </div>
  )
}

export function NotificationsPage(): JSX.Element {
  const enabled = useClientSetting('notificationsEnabled')
  const unfocusedOnly = useClientSetting('notifyOnlyWhenUnfocused')
  return (
    <div className="flex flex-col gap-1">
      <SettingRow label="Enable notifications" description="Show a notification when an agent finishes or needs input">
        <Toggle checked={enabled} onChange={(v) => setClientSetting('notificationsEnabled', v)} />
      </SettingRow>
      <SettingRow label="Only when window unfocused" description="Skip notifications while Cate is in focus">
        <Toggle checked={unfocusedOnly} onChange={(v) => setClientSetting('notifyOnlyWhenUnfocused', v)} disabled={!enabled} />
      </SettingRow>
    </div>
  )
}

export function EditorPage(): JSX.Element {
  const fontSize = useClientSetting('editorFontSize')
  const fontFamily = useClientSetting('editorFontFamily')
  return (
    <div className="flex flex-col gap-1">
      <SettingRow label="Editor font size">
        <NumberInput value={fontSize} onChange={(v) => setClientSetting('editorFontSize', v)} min={8} max={32} step={1} />
      </SettingRow>
      <SettingRow label="Editor font family" description="Blank = default (Menlo, Monaco)">
        <TextInput value={fontFamily} onChange={(v) => setClientSetting('editorFontFamily', v)} placeholder="e.g., JetBrains Mono" />
      </SettingRow>
    </div>
  )
}

export function TerminalPage({ workspaceId }: SettingsPageProps): JSX.Element {
  const fontFamily = useClientSetting('terminalFontFamily')
  const fontSize = useClientSetting('terminalFontSize')
  const scrollSpeed = useClientSetting('terminalScrollSpeed')
  const contrast = useClientSetting('terminalContrast')
  const cursorBlink = useClientSetting('terminalCursorBlink')
  const optionIsMeta = useClientSetting('terminalOptionIsMeta')
  const linkTarget = useClientSetting('terminalLinkOpenTarget')
  const ws = useWorkspaceSettings(workspaceId)
  return (
    <div className="flex flex-col gap-1">
      {workspaceId && (
        <SettingRow label="Default shell path" description="For this workspace. Leave blank to auto-detect ($SHELL, then a platform default).">
          <TextInput value={ws.defaultShellPath} onChange={(v) => setWs(workspaceId, 'defaultShellPath', v)} placeholder="Auto-detect" />
        </SettingRow>
      )}
      <SettingRow label="Font family override">
        <TextInput value={fontFamily} onChange={(v) => setClientSetting('terminalFontFamily', v)} placeholder="e.g., Menlo, Monaco" />
      </SettingRow>
      <SettingRow label="Font size override" description="0 = use default">
        <NumberInput value={fontSize} onChange={(v) => setClientSetting('terminalFontSize', v)} min={0} max={32} step={1} />
      </SettingRow>
      <SettingRow label="Scroll speed" description={`${scrollSpeed.toFixed(2)}x`}>
        <Slider value={scrollSpeed} onChange={(v) => setClientSetting('terminalScrollSpeed', v)} min={0.25} max={3.0} step={0.25} />
      </SettingRow>
      <SettingRow
        label="Text contrast"
        description={contrast <= 1 ? 'Off. Theme colors shown exactly.' : `${contrast.toFixed(1)}:1. Lifts dim text (4.5 = WCAG AA).`}
      >
        {/* Above ~7:1 nearly all text is already forced to black or white. */}
        <Slider value={contrast} onChange={(v) => setClientSetting('terminalContrast', v)} min={1} max={7} step={0.1} />
      </SettingRow>
      <SettingRow label="Blink cursor" description="A steady cursor avoids a compositor redraw on every blink, saving power when idle.">
        <Toggle checked={cursorBlink} onChange={(v) => setClientSetting('terminalCursorBlink', v)} />
      </SettingRow>
      <SettingRow label="Use ⌥ Option as Meta" description="On: ⌥+key sends Meta/ESC (e.g. ⌥F / ⌥B word motion). Off: ⌥ types special characters.">
        <Toggle checked={optionIsMeta} onChange={(v) => setClientSetting('terminalOptionIsMeta', v)} />
      </SettingRow>
      <SettingRow
        label="Open terminal links"
        keywords="Ask each time On canvas In system browser"
        description="Where Cmd/Ctrl+click on a terminal link opens. Cmd/Ctrl+Shift+click always uses the system browser."
      >
        <Select
          value={linkTarget}
          onChange={(v) => setClientSetting('terminalLinkOpenTarget', v as ClientSettings['terminalLinkOpenTarget'])}
          options={[
            { value: 'ask', label: 'Ask each time' },
            { value: 'canvas', label: 'On canvas' },
            { value: 'external', label: 'In system browser' },
          ]}
        />
      </SettingRow>
      {workspaceId && (
        <>
          <SettingRow label="Scrollback" description="Lines each terminal of this workspace keeps.">
            <NumberInput value={ws.terminalScrollback} onChange={(v) => setWs(workspaceId, 'terminalScrollback', v)} min={100} max={10000} step={100} />
          </SettingRow>
          <SettingRow
            label="Auto-suspend idle background terminals"
            description="Pause terminals idle and offscreen for 2 minutes to free memory. Resumes instantly on focus."
          >
            <Toggle checked={ws.autoSuspendIdleTerminals} onChange={(v) => setWs(workspaceId, 'autoSuspendIdleTerminals', v)} />
          </SettingRow>
        </>
      )}
    </div>
  )
}

export function BrowserPage({ workspaceId }: SettingsPageProps): JSX.Element {
  const proxyUrl = useClientSetting('browserProxyUrl')
  const ws = useWorkspaceSettings(workspaceId)
  const [proxyDraft, setProxyDraft] = useState(proxyUrl)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => { setProxyDraft(proxyUrl) }, [proxyUrl])

  const saveProxy = () => {
    const value = proxyDraft.trim()
    setProxyDraft(value)
    if (value !== proxyUrl) setClientSetting('browserProxyUrl', value)
  }

  const clearHistory = async () => {
    if (!workspaceId) return
    if (!confirmingClear) {
      setConfirmingClear(true)
      setMessage('')
      return
    }
    try {
      await tryRuntimeFor(workspaceId)?.browserData.clearHistory()
      setMessage('History cleared.')
    } catch (err) {
      setMessage(errorMessage(err, 'Could not clear history.'))
    }
    setConfirmingClear(false)
  }

  return (
    <div className="flex flex-col gap-1">
      {workspaceId && (
        <>
          <SettingRow label="Homepage">
            <TextInput
              value={ws.browserHomepage}
              onChange={(v) => setWs(workspaceId, 'browserHomepage', v)}
              placeholder="about:blank"
              disabled={ws.browserNewTabBehavior !== 'homepage'}
            />
          </SettingRow>
          <SettingRow label="Search engine" keywords="Google DuckDuckGo Bing Brave">
            <Select
              value={ws.browserSearchEngine}
              onChange={(v) => setWs(workspaceId, 'browserSearchEngine', v as WorkspaceSettings['browserSearchEngine'])}
              options={[
                { value: 'google', label: 'Google' },
                { value: 'duckDuckGo', label: 'DuckDuckGo' },
                { value: 'bing', label: 'Bing' },
                { value: 'brave', label: 'Brave' },
              ]}
            />
          </SettingRow>
          <SettingRow label="New tab opens" keywords="Start page Homepage">
            <Select
              value={ws.browserNewTabBehavior}
              onChange={(v) => setWs(workspaceId, 'browserNewTabBehavior', v as WorkspaceSettings['browserNewTabBehavior'])}
              options={[
                { value: 'startPage', label: 'Start page' },
                { value: 'homepage', label: 'Homepage' },
              ]}
            />
          </SettingRow>
        </>
      )}
      <SettingRow
        label="Proxy"
        description="This device's upstream proxy for every browser panel. Leave empty for a direct connection. Supports authenticated proxy URLs, PAC scripts, and ;bypass= lists."
      >
        <TextInput
          value={proxyDraft}
          onChange={setProxyDraft}
          onBlur={saveProxy}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
          placeholder="http://proxy.company.com:8080"
          layoutClassName="w-72 px-2"
          className="font-mono"
        />
      </SettingRow>
      {workspaceId && (
        <SettingRow
          label="Clear browsing history"
          description="The history this workspace's browser panels share."
          hint={message ? <span className="text-xs text-muted">{message}</span> : undefined}
        >
          <SecondaryButton onClick={() => void clearHistory()}>
            {confirmingClear ? 'Confirm clear' : 'Clear…'}
          </SecondaryButton>
        </SettingRow>
      )}
    </div>
  )
}
