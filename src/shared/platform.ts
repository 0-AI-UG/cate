function detectPlatform(): 'darwin' | 'win32' | 'linux' | 'unknown' {
  if (typeof navigator !== 'undefined' && navigator.platform) {
    const p = navigator.platform.toLowerCase()
    if (p.includes('mac')) return 'darwin'
    if (p.includes('win')) return 'win32'
    return 'linux'
  }
  if (typeof process !== 'undefined' && process.platform) {
    return process.platform as 'darwin' | 'win32' | 'linux'
  }
  return 'unknown'
}

const platform = detectPlatform()
export const isMac = platform === 'darwin'
export const isWindows = platform === 'win32'
export const isLinux = platform === 'linux'
