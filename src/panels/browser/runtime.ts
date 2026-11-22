// What the daemon's composition root needs for the browser panel.

import definition from './definition'
import { BrowserSession, createBrowserSessionClass, type BrowserSessionDeps } from './session'

export { definition as browserDefinition, BrowserSession, createBrowserSessionClass, type BrowserSessionDeps }

/** The registry entry: `registry.register(entry.definition, entry.session)`. */
export function browserPanel(deps: BrowserSessionDeps) {
  return { definition, session: createBrowserSessionClass(deps) }
}
