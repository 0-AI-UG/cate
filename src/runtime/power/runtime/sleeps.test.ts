import { expect, it } from 'vitest'
import { machineSleeps } from './sleeps'

const noFs = { readDir: () => { throw new Error('ENOENT') }, readFile: () => '' }

it('macOS and Windows sleep', () => {
  expect(machineSleeps({ platform: 'darwin' })).toBe(true)
  expect(machineSleeps({ platform: 'win32' })).toBe(true)
})

it('Linux sleeps with a graphical session, under WSL or with a battery, not as a server', () => {
  expect(machineSleeps({ platform: 'linux', env: {}, ...noFs })).toBe(false)
  expect(machineSleeps({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, ...noFs })).toBe(true)
  expect(machineSleeps({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, ...noFs })).toBe(true)
  const files: Record<string, string> = { '/sys/class/power_supply/AC/type': 'Mains\n', '/sys/class/power_supply/BAT0/type': 'Battery\n' }
  expect(machineSleeps({ platform: 'linux', env: {}, readDir: () => ['AC', 'BAT0'], readFile: (f) => files[f] })).toBe(true)
  expect(machineSleeps({ platform: 'linux', env: {}, readDir: () => ['AC'], readFile: (f) => files[f] })).toBe(false)
})
