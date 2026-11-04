/** DOM-only password events, bundled into the sandboxed guest preload. */
export function installPasswordBridge(
  send: (channel: string, payload: unknown) => void,
  automated: () => boolean,
): () => void {
  const controller = new AbortController()
  const options = { capture: true, signal: controller.signal }
  const targetAttribute = 'data-cate-autofill-target'
  let marked: HTMLInputElement | null = null
  let previousUsername = ''
  const dismiss = () => send('cate-browser-password-focus', { dismiss: true })
  const isUsername = (input: HTMLInputElement) =>
    ['text', 'email', 'tel'].includes(input.type)
    && (/username|email/.test(input.autocomplete)
      || input.type === 'email'
      || /user|login|email|account|identifier/i.test(`${input.name} ${input.id}`))

  document.addEventListener('focusin', (event) => {
    const input = event.target
    if (!(input instanceof HTMLInputElement) || input.disabled || input.readOnly
      || (input.type !== 'password' && !isUsername(input))) return dismiss()
    if (marked && marked !== input) marked.removeAttribute(targetAttribute)
    const targetId = crypto.randomUUID()
    input.setAttribute(targetAttribute, targetId)
    marked = input
    const rect = input.getBoundingClientRect()
    send('cate-browser-password-focus', {
      targetId, rect: { left: rect.left, bottom: rect.bottom, width: rect.width, height: rect.height },
    })
  }, options)
  document.addEventListener('scroll', dismiss, options)

  const capture = (scope: HTMLFormElement | HTMLElement) => {
    const inputs = (scope instanceof HTMLFormElement ? Array.from(scope.elements) : Array.from(scope.querySelectorAll('input')))
      .filter((field): field is HTMLInputElement => field instanceof HTMLInputElement && !field.disabled)
    const username = inputs.find((field) => isUsername(field) && field.value)
      ?? inputs.find((field) => field.type === 'text' && field.value)
    if (username) previousUsername = username.value
    const passwords = inputs.filter((field) => field.type === 'password' && field.value)
    const password = passwords.find((field) => field.autocomplete === 'new-password')
      ?? passwords.find((field) => field.autocomplete === 'current-password') ?? passwords[0]
    if (!password) return
    send('cate-browser-password-submit', {
      origin: location.origin, username: username?.value ?? previousUsername,
      password: password.value, usernameElement: username ? username.name || username.id : '',
      passwordElement: password.name || password.id, automated: automated(),
    })
  }
  document.addEventListener('submit', (event) => {
    if (event.target instanceof HTMLFormElement) capture(event.target)
  }, options)
  // Capture before page handlers clear the fields or replace an SPA login form.
  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return
    const button = event.target.closest('button,input[type=submit],input[type=button],[role=button]')
    if (!button || button.hasAttribute('disabled')) return
    const label = button.textContent || button.getAttribute('value') || button.getAttribute('aria-label') || ''
    const submits = (button instanceof HTMLButtonElement || button instanceof HTMLInputElement) && button.type === 'submit'
    if (!submits && !/sign\s*in|log\s*in|sign\s*up|register|continue|next|anmelden|weiter/i.test(label)) return
    const form = (button instanceof HTMLButtonElement || button instanceof HTMLInputElement) ? button.form : button.closest('form')
    capture(form ?? document.body)
  }, options)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') dismiss()
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) capture(event.target.form ?? document.body)
  }, options)
  return () => controller.abort()
}
