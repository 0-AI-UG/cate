// kernel/interaction public entry: the client core's side of interaction, no UI: the
// ClientUi slot, the action catalog and the shortcut registry. The React
// pieces are the desktop UI's (shells/desktop/ui/kernel/interaction).

export { installClientUi, clientUi } from './clientUi'
export {
  createShortcutRegistry,
  createMemoryShortcutRegistry,
  installShortcutRegistry,
  shortcutRegistry,
  subscribeShortcuts,
  shortcutDisplay,
  type ShortcutRegistry,
  type ShortcutSettings,
  type ShortcutOverrides,
  type ResolvedShortcuts,
} from './shortcuts/registry'
export {
  declareActions,
  actionSpec,
  declaredActions,
  subscribeDeclaredActions,
  type DeclaredAction,
} from './actions/catalog'
export { errorMessage } from './errorMessage'
