// Runs before the client boots: on macOS the main window is vibrant, so the
// boot splash (in index.html) tints over a transparent body.

const params = new URLSearchParams(location.search)
const platform = params.get('platform')
const isMac = platform ? platform === 'darwin' : navigator.userAgent.includes('Mac')
if (isMac && (params.get('window') || 'main') === 'main') {
  document.body.style.background = 'transparent'
  const splash = document.querySelector<HTMLElement>('#root > div')
  if (splash) splash.style.background = `color-mix(in srgb, ${params.get('bg') || '#232220'} 30%, transparent)`
}

export {}
