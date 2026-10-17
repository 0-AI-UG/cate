import type { ClientUi } from './contract'

// Views reach the person using this client only through this port. Each shell
// installs its own implementation; sessions and runtime code never call it.
let installed: ClientUi | undefined

export function installClientUi(ui: ClientUi): void { installed = ui }

export function clientUi(): ClientUi {
  if (!installed) throw new Error('No client UI installed')
  return installed
}
