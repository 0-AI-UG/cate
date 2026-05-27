export interface NativeAppPreset {
  id: string
  label: string
  exeCandidates: string[]
  titlePattern: string
  launchArgs?: string[]
}

export const NATIVE_APP_PRESETS: NativeAppPreset[] = [
  {
    id: 'cursor',
    label: 'Cursor',
    exeCandidates: [
      '%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe',
      '%LOCALAPPDATA%\\Programs\\Cursor\\Cursor.exe',
    ],
    titlePattern: 'Cursor',
  },
  {
    id: 'warp',
    label: 'Warp',
    exeCandidates: [
      '%LOCALAPPDATA%\\Programs\\Warp\\warp.exe',
      '%LOCALAPPDATA%\\Microsoft\\WindowsApps\\warp.exe',
    ],
    titlePattern: 'Warp',
  },
  {
    id: 'zen',
    label: 'Zen Browser',
    exeCandidates: [
      '%LOCALAPPDATA%\\Programs\\Zen Browser\\zen.exe',
      '%PROGRAMFILES%\\Zen Browser\\zen.exe',
      '%PROGRAMFILES(X86)%\\Zen Browser\\zen.exe',
    ],
    titlePattern: 'Zen',
  },
  {
    id: 'helium',
    label: 'Helium',
    exeCandidates: [
      '%LOCALAPPDATA%\\Programs\\Helium\\Helium.exe',
      '%PROGRAMFILES%\\Helium\\Helium.exe',
    ],
    titlePattern: 'Helium',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    exeCandidates: [
      '%LOCALAPPDATA%\\Programs\\OpenCode\\OpenCode.exe',
      '%PROGRAMFILES%\\OpenCode\\OpenCode.exe',
      '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps\\opencode.exe',
    ],
    titlePattern: 'OpenCode',
  },
]

export function getNativeAppPreset(id: string | undefined): NativeAppPreset | undefined {
  if (!id) return undefined
  return NATIVE_APP_PRESETS.find((preset) => preset.id === id)
}
