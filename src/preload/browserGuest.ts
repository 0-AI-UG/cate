// Browser-guest preload — deliberately tiny and one-way. Remote pages receive
// no API. The preload reports password focus for autofill and sends submitted
// login credentials directly to main for a native, user-approved save prompt.

import { ipcRenderer, webFrame } from 'electron'

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

const CHANNEL = 'cate-browser-password-focus'
const SUBMIT_CHANNEL = 'cate-browser-password-submit'
const USER_INPUT_CHANNEL = 'cate-browser-user-input'
const AUTOMATION_INPUT_CHANNEL = 'cate-browser-automation-input'
const TARGET_ATTRIBUTE = 'data-cate-autofill-target'
let marked: HTMLInputElement | null = null
let automationInput = false

ipcRenderer.on(AUTOMATION_INPUT_CHANNEL, (_event, active: unknown) => {
  automationInput = active === true
})

// This is a cancellation signal, not an input transport. Pointer and keyboard
// events continue through Chromium's native webview path; main uses the signal
// only to preempt automation that was already in flight for this guest.
for (const eventName of ['pointerdown', 'keydown', 'wheel'] as const) {
  document.addEventListener(eventName, (event) => {
    if (event.isTrusted && !automationInput) ipcRenderer.send(USER_INPUT_CHANNEL)
  }, true)
}

document.addEventListener('focusin', (event) => {
  const input = event.target
  if (!(input instanceof HTMLInputElement) || input.type.toLowerCase() !== 'password') return

  if (marked && marked !== input) marked.removeAttribute(TARGET_ATTRIBUTE)
  const targetId = crypto.randomUUID()
  input.setAttribute(TARGET_ATTRIBUTE, targetId)
  marked = input

  const rect = input.getBoundingClientRect()
  ipcRenderer.send(CHANNEL, {
    targetId,
    rect: {
      left: rect.left,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    },
  })
}, true)

function elementName(input: HTMLInputElement): string {
  return input.name || input.id
}

document.addEventListener('submit', (event) => {
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return
  const inputs = Array.from(form.elements).filter(
    (element): element is HTMLInputElement => element instanceof HTMLInputElement && !element.disabled,
  )
  const passwords = inputs.filter((input) => input.type.toLowerCase() === 'password' && input.value)
  const password = passwords.find((input) => input.autocomplete.toLowerCase() === 'current-password')
    ?? passwords.find((input) => input.autocomplete.toLowerCase() === 'new-password')
    ?? passwords[0]
  if (!password) return

  const usernameFields = inputs.filter((input) =>
    input !== password && input.type.toLowerCase() !== 'password' && input.value)
  const username = usernameFields.find((input) => input.autocomplete.toLowerCase() === 'username')
    ?? usernameFields.find((input) => input.type.toLowerCase() === 'email')
    ?? usernameFields.find((input) => ['text', 'search', 'tel', 'url'].includes(input.type.toLowerCase()))

  ipcRenderer.send(SUBMIT_CHANNEL, {
    origin: location.origin,
    username: username?.value ?? '',
    password: password.value,
    usernameElement: username ? elementName(username) : '',
    passwordElement: elementName(password),
    automated: automationInput,
  })
}, true)
