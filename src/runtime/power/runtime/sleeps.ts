// Whether the runtime's machine sleeps on its own (architecture 7.4), so
// settings can speak of keeping it awake or not: macOS and Windows do; Linux
// does with a battery, a graphical session or under WSL (its Windows host
// sleeps). A server does not.

import fs from 'node:fs'

export interface MachineSleepsDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  readDir?: (dir: string) => string[]
  readFile?: (file: string) => string
}

export function machineSleeps(deps: MachineSleepsDeps = {}): boolean {
  const platform = deps.platform ?? process.platform
  if (platform === 'darwin' || platform === 'win32') return true
  if (platform !== 'linux') return false
  const env = deps.env ?? process.env
  if (env.WSL_DISTRO_NAME || env.DISPLAY || env.WAYLAND_DISPLAY) return true
  const readDir = deps.readDir ?? ((dir) => fs.readdirSync(dir))
  const readFile = deps.readFile ?? ((file) => fs.readFileSync(file, 'utf8'))
  try {
    return readDir('/sys/class/power_supply').some((name) => {
      try { return readFile(`/sys/class/power_supply/${name}/type`).trim() === 'Battery' } catch { return false }
    })
  } catch {
    return false
  }
}
