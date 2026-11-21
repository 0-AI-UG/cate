// Installed in the driver's isolated world in every frame. No field values
// leave the page; this only positions IME and selects the secure input proxy.
export function installInputBridge(send: (context: unknown) => void): void {
  let pending = false
  const report = () => {
    if (pending) return
    pending = true
    requestAnimationFrame(() => {
      pending = false
      let target = document.activeElement
      while (target?.shadowRoot?.activeElement) target = target.shadowRoot.activeElement
      // The focused child frame reports its own field and frame offset.
      if (target instanceof HTMLIFrameElement) return
      const rect = target?.getBoundingClientRect()
      const editable = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLElement && target.isContentEditable
      send({ editable, secure: target instanceof HTMLInputElement && target.type === 'password',
        mode: target instanceof HTMLElement ? target.inputMode : '',
        label: (target?.getAttribute('aria-label') || (target instanceof HTMLInputElement ? Array.from(target.labels ?? []).map(label => label.textContent ?? '').join(' ') : '') || 'Web page input').slice(0, 512),
        caret: rect ? { x: rect.left + 4, y: rect.top + 4, height: Math.max(16, Math.min(rect.height, 32)) } : null,
      })
    })
  }
  for (const name of ['focusin', 'selectionchange', 'input']) document.addEventListener(name, report, true)
  // A driver can attach after autofocus has already selected the field.
  if (document.hasFocus()) report()
}
