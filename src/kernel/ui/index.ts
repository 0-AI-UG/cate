// kernel/ui public entry (client side): the ClientUi slot, theme manager,
// shortcut registry, icons and shared React primitives.

export { installClientUi, clientUi } from './clientUi'
export {
  installAppearanceHost,
  applyTheme,
  getActiveTheme,
  subscribeTheme,
  applyUiScale,
  type AppearanceHost,
} from './theme/themeManager'
export {
  createShortcutRegistry,
  createMemoryShortcutRegistry,
  installShortcutRegistry,
  shortcutRegistry,
  useResolvedShortcuts,
  useShortcutLabel,
  type ShortcutRegistry,
  type ShortcutSettings,
  type ShortcutOverrides,
  type ResolvedShortcuts,
} from './shortcuts/registry'
export { Icon, type IconProps } from './icons/Icon'
export { T3Logo } from './icons/T3Logo'
export { Button, IconButton, buttonClassName, type ButtonVariant, type ButtonSize } from './components/Button'
export { Tooltip } from './components/Tooltip'
export { Spinner, LoadingState } from './components/Spinner'
export { InlineNotice } from './components/InlineNotice'
export { Modal, ModalCard, PaletteDialogShell, BACKDROP, CARD_SURFACE, btn, inputCls, SEGMENT } from './components/Modal'
export {
  useDismissableLayer,
  POPOVER_SURFACE,
  verticalPopoverPosition,
  useViewportPopoverPosition,
  PopoverSurface,
  useNodePopover,
  NodePopover,
  type ViewportPopoverPosition,
} from './components/Popover'
export { PanelCenteredState } from './components/PanelCenteredState'
export { PaletteTextInput } from './components/PaletteTextInput'
export { ErrorBoundary, installErrorReporter, type ErrorReporter } from './components/ErrorBoundary'
export { PanelErrorBoundary } from './components/PanelErrorBoundary'
export { errorMessage } from './components/errorMessage'
export {
  SettingsSearchContext,
  useSettingsSearch,
  matchesQuery,
  SettingRow,
  SearchableBlock,
  SecondaryButton,
  Toggle,
  TextInput,
  NumberInput,
  Select,
  Slider,
  type SettingsSearchState,
} from './components/Settings'
export { SidebarSectionHeader, SidebarHeaderButton } from './components/SidebarSectionHeader'
