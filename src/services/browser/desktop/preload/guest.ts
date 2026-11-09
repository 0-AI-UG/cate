// Browser-guest preload. The optional passkey bridge is restricted to WebAuthn;
// no general Electron API is exposed to remote pages. Password focus and
// submitted credentials go to the host view, which asks the runtime's saved
// passwords (`browserData`) and the user.

import { contextBridge, ipcRenderer, webFrame } from 'electron'
import { installPasskeyPageBridge } from './passkeyPageBridge'
import { installPasswordBridge } from './passwordBridge'

if (process.isMainFrame && ipcRenderer.sendSync('cate-passkeys-available')) {
  contextBridge.exposeInMainWorld('__catePasskeys', {
    request: (input: unknown) => ipcRenderer.invoke('cate-passkeys-request', input),
    cancel: (id: string) => ipcRenderer.send('cate-passkeys-cancel', id),
  })
  contextBridge.executeInMainWorld({ func: installPasskeyPageBridge })
}

// JavaScript dialogs: Electron answers a guest's `confirm` with false and has
// no `prompt`. These wait on desktop main (`dialogs.ts`) instead, which shows
// the dialog in the panel and lets an agent answer it. The bridged function
// is called synchronously, so the page blocks as on a native dialog.
if (process.isMainFrame) {
  contextBridge.executeInMainWorld({
    func: (ask: (type: string, message: string, defaultPrompt: string) => unknown) => {
      const text = (value: unknown) => (value === undefined ? '' : String(value))
      Object.defineProperties(window, {
        alert: { configurable: true, writable: true, value: function alert(message?: unknown) { ask('alert', text(message), '') } },
        confirm: { configurable: true, writable: true, value: function confirm(message?: unknown) { return ask('confirm', text(message), '') === true } },
        prompt: { configurable: true, writable: true, value: function prompt(message?: unknown, defaultPrompt?: unknown) {
          const answer = ask('prompt', text(message), text(defaultPrompt))
          return typeof answer === 'string' ? answer : null
        } },
      })
    },
    args: [(type: string, message: string, defaultPrompt: string) => ipcRenderer.sendSync('cate-browser-dialog', { type, message, defaultPrompt })],
  })
}

// Keep this preload self-contained. Sharing the IPC constants module with the
// renderer preload makes electron-vite emit a chunk that Electron's sandboxed
// preload loader cannot require.

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

const USER_INPUT_CHANNEL = 'cate-browser-user-input'
const AUTOMATION_INPUT_CHANNEL = 'cate-browser-automation-input'
let automationInput = false

ipcRenderer.on(AUTOMATION_INPUT_CHANNEL, (_event, active: unknown) => {
  automationInput = active === true
})

// This is a cancellation signal, not an input transport. Pointer and keyboard
// events continue through Chromium's native webview path; main uses the signal
// only to preempt automation that was already in flight for this guest.
// Scrolling to watch an agent is not taking over.
for (const eventName of ['pointerdown', 'keydown'] as const) {
  document.addEventListener(eventName, (event) => {
    if (event.isTrusted && !automationInput) ipcRenderer.send(USER_INPUT_CHANNEL)
  }, true)
}

// Keep frame credentials scoped to the top-level page the host validates.
if (process.isMainFrame) installPasswordBridge(
  (channel, payload) => ipcRenderer.sendToHost(channel, payload),
  () => automationInput,
)

// A conservative lifetime signal: even input in a subframe protects the page.
let dirtySent = false
for (const name of ['input', 'change'] as const) {
  document.addEventListener(name, () => {
    if (!dirtySent) { dirtySent = true; ipcRenderer.send('cate-browser-dirty') }
  }, true)
}
