import { useEffect, type RefObject } from 'react'

const ITEM = '[data-menu-item]'

/** Marks the first nine enabled rows of a menu or list dialog with their digit
 *  (the badge is drawn from `data-key` in globals.css) and picks a row when its
 *  digit is pressed. Rows opt in with `data-menu-item`; rows hidden or disabled
 *  are skipped. */
export function useMenuNumbers(ref: RefObject<HTMLElement | null>, enabled = true): void {
  useEffect(() => {
    const root = ref.current
    if (!root || !enabled) return
    const rows = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(ITEM)]
      .filter((row) => !(row as HTMLButtonElement).disabled && row.getAttribute('aria-disabled') !== 'true' && !row.closest('[hidden]') && getComputedStyle(row).display !== 'none')
    const mark = (): void => {
      const usable = rows()
      for (const row of root.querySelectorAll<HTMLElement>(`${ITEM}[data-key]`)) {
        if (!usable.includes(row)) row.removeAttribute('data-key')
      }
      usable.forEach((row, index) => {
        const key = index < 9 ? String(index + 1) : null
        if (key && row.dataset.key !== key) row.dataset.key = key
        else if (!key && row.dataset.key) row.removeAttribute('data-key')
      })
    }
    mark()
    const observer = new MutationObserver(mark)
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden'] })
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || !/^[1-9]$/.test(event.key)) return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const row = rows()[Number(event.key) - 1]
      if (!row) return
      event.preventDefault()
      event.stopPropagation()
      row.click()
    }
    root.addEventListener('keydown', onKeyDown)
    return () => { observer.disconnect(); root.removeEventListener('keydown', onKeyDown) }
  })
}
