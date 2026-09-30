// Window chrome. macOS keeps its native traffic lights: a small drag strip
// over them, nothing else. Windows and Linux are frameless: a title bar with
// the application menu's top-level labels (each pops the native submenu) and
// our own window controls. In fullscreen both step aside.

import { useEffect, useState, type CSSProperties } from 'react'
import { Copy, Minus, Square, X } from 'lucide-react'
import { useShortcutLabel } from '@kernel/ui'
import type { DesktopApi, WindowState } from '../contract'
import { TRAFFIC_LIGHTS_WIDTH } from './desktopPort'

/** Matches the top chrome of dock tabs and the sidebar. */
const MAC_CHROME_HEIGHT = 44
const TITLE_BAR_HEIGHT = 28

const DRAG = { WebkitAppRegion: 'drag' } as CSSProperties
const NO_DRAG = { WebkitAppRegion: 'no-drag' } as CSSProperties

function useWindowState(api: DesktopApi): WindowState {
  const [state, setState] = useState<WindowState>({ fullscreen: false, maximized: false, focused: true })
  useEffect(() => {
    let alive = true
    void api.window.state().then((s) => { if (alive) setState(s) }, () => {})
    const off = api.window.onState(setState)
    return () => { alive = false; off() }
  }, [api])
  return state
}

function MenuBar({ api }: { api: DesktopApi }) {
  const [labels, setLabels] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    void api.menu.barItems().then((items) => { if (alive) setLabels(items) }, () => {})
    return () => { alive = false }
  }, [api])
  if (labels.length === 0) return null
  return (
    <div className="flex items-stretch h-full" style={NO_DRAG}>
      {labels.map((label, index) => (
        <button
          key={`${index}-${label}`}
          type="button"
          className="px-2.5 h-full flex items-center text-xs text-secondary hover:bg-surface-hover hover:text-primary transition-colors whitespace-nowrap"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            void api.menu.popupBarItem(index, rect.left, rect.bottom)
          }}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function WindowControls({ api, maximized }: { api: DesktopApi; maximized: boolean }) {
  const shortcutLabel = useShortcutLabel()
  const button = 'h-full w-11 flex items-center justify-center text-secondary transition-colors'
  return (
    <div className="flex items-center h-full shrink-0" style={NO_DRAG}>
      <button type="button" aria-label="Minimize" title="Minimize" className={`${button} hover:bg-surface-hover hover:text-primary`} onClick={() => void api.window.minimize()}>
        <Minus size={15} />
      </button>
      <button
        type="button"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        title={maximized ? 'Restore' : 'Maximize'}
        className={`${button} hover:bg-surface-hover hover:text-primary`}
        onClick={() => void api.window.toggleMaximize()}
      >
        {maximized ? <Copy size={13} /> : <Square size={12} />}
      </button>
      <button type="button" aria-label="Close" title={shortcutLabel('closeWindow', 'Close')} className={`${button} hover:bg-red-600 hover:text-white`} onClick={() => void api.window.close()}>
        <X size={15} />
      </button>
    </div>
  )
}

/** The frameless title bar above the content (Windows and Linux). */
export function TitleBar({ api, platform }: { api: DesktopApi; platform: string }) {
  const state = useWindowState(api)
  if (platform === 'darwin' || state.fullscreen) return null
  return (
    <div className="titlebar-drag shrink-0 bg-titlebar-bg select-none flex items-stretch" style={{ height: TITLE_BAR_HEIGHT, ...DRAG }}>
      <MenuBar api={api} />
      <div className="flex-1 min-w-0" onDoubleClick={() => void api.window.toggleMaximize()} />
      <WindowControls api={api} maximized={state.maximized} />
    </div>
  )
}

/** The drag strip over the macOS traffic lights. */
export function MacTrafficLightStrip({ api, platform }: { api: DesktopApi; platform: string }) {
  const state = useWindowState(api)
  if (platform !== 'darwin' || state.fullscreen) return null
  return <div className="absolute top-0 left-0 z-40 select-none" style={{ height: MAC_CHROME_HEIGHT, width: TRAFFIC_LIGHTS_WIDTH, ...DRAG }} />
}
