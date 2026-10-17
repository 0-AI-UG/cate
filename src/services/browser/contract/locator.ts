// Finding an element by the role and name a snapshot shows (`--role button
// --name Save`) instead of by its id. The page driver matches the elements of
// a fresh accessibility snapshot; a locator must match exactly one.
import type { BrowserElement } from './automation'

export interface BrowserLocator {
  role?: string
  /** Contained in the element's name, in any case; the whole name, same case, with `exact`. */
  name?: string
  exact?: boolean
}

/** The locator a call's arguments carry, if any. */
export function browserLocatorOf(args: Record<string, unknown>): BrowserLocator | undefined {
  const role = typeof args.role === 'string' && args.role ? args.role : undefined
  const name = typeof args.name === 'string' && args.name ? args.name : undefined
  if (!role && !name) return undefined
  return { ...(role ? { role } : {}), ...(name ? { name } : {}), ...(args.exact === true ? { exact: true } : {}) }
}

const normalized = (text: string): string => text.replace(/\s+/g, ' ').trim()

export function matchBrowserElements(elements: readonly BrowserElement[], locator: BrowserLocator): BrowserElement[] {
  const role = locator.role?.toLowerCase()
  const name = locator.name === undefined ? undefined : normalized(locator.name)
  return elements.filter((element) => {
    if (role !== undefined && element.role.toLowerCase() !== role) return false
    if (name === undefined) return true
    const own = normalized(element.name)
    return locator.exact ? own === name : own.toLowerCase().includes(name.toLowerCase())
  })
}

/** `role=button name~"Save"`, for errors. */
export function describeBrowserLocator(locator: BrowserLocator): string {
  return [
    locator.role ? `role=${locator.role}` : '',
    locator.name ? `name${locator.exact ? '=' : '~'}${JSON.stringify(locator.name)}` : '',
  ].filter(Boolean).join(' ')
}

/** An element as a snapshot line: `- button "Save" [id=12]`. */
export function describeBrowserElement(element: BrowserElement): string {
  return `- ${element.role}${element.name ? ` ${JSON.stringify(element.name)}` : ''} [id=${element.id}]`
}
