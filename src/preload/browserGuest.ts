// Browser-guest preload — deliberately tiny and one-way. Remote pages receive
// no API. The preload only tells the embedding BrowserPanel when a password
// field is focused, using an opaque marker shared with the main-process
// agent-browser autofill path.

import { ipcRenderer, webFrame } from 'electron'

// Keep this preload self-contained. Sharing the IPC constants module with the
// renderer preload makes electron-vite emit a chunk that Electron's sandboxed
// preload loader cannot require.
const BROWSER_VIEW_GUEST_MESSAGE = 'browserView:guestMessage'

// Match Cate's thin, rounded panel scrollbar inside remote browser pages. The
// guest cannot inherit renderer theme variables, so these colors mirror the
// dark theme's --scrollbar-thumb tokens from globals.css.
webFrame.insertCSS(`
  ::-webkit-scrollbar {
    width: 8px !important;
    height: 8px !important;
  }
  ::-webkit-scrollbar-track {
    background: transparent !important;
  }
  ::-webkit-scrollbar-thumb {
    background-color: rgba(255, 255, 255, 0.12) !important;
    border-radius: 9999px !important;
    border-top: 2px solid transparent !important;
    border-bottom: 2px solid transparent !important;
    border-left: 3px solid transparent !important;
    border-right: 1px solid transparent !important;
    background-clip: padding-box !important;
  }
  ::-webkit-scrollbar-thumb:hover {
    background-color: rgba(255, 255, 255, 0.20) !important;
  }
`)

const CHANNEL = 'cate-browser-password-focus'
const TARGET_ATTRIBUTE = 'data-cate-autofill-target'
let marked: HTMLInputElement | null = null

document.addEventListener('focusin', (event) => {
  const input = event.target
  if (!(input instanceof HTMLInputElement) || input.type.toLowerCase() !== 'password') return

  if (marked && marked !== input) marked.removeAttribute(TARGET_ATTRIBUTE)
  const targetId = crypto.randomUUID()
  input.setAttribute(TARGET_ATTRIBUTE, targetId)
  marked = input

  const rect = input.getBoundingClientRect()
  ipcRenderer.send(BROWSER_VIEW_GUEST_MESSAGE, CHANNEL, {
    targetId,
    rect: {
      left: rect.left,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    },
  })
}, true)
