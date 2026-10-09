// services/t3 client side: the harness page's scripts, its theming and the
// guest bridge (hosting the page in a webview is the desktop side's).

export {
  T3_CHAT_ONLY_CSS,
  t3BrandingScript,
  isT3ProviderSettingsNavigation,
  isAllowedT3Navigation,
  t3ThreadIdFromUrl,
} from './surface'
export { t3ThemeScript } from './theme'
export {
  HOST_MESSAGE_PREFIX,
  CANCEL_PENDING_SCRIPT,
  parseHostMessage,
  hostReplyScript,
  t3HostBridgeScript,
  type T3HostAction,
  type T3HostRequest,
} from './bridge'
export { createT3HostDispatcher, type T3HostActions, type T3HostDispatcher } from './dispatcher'
export { t3FileDropScript, t3ChangesScript, t3SendTextScript, t3NavigateScript, type T3Guest, type GuestDropFile } from './guest'
export { t3Conversations, t3ProductCopy, type T3ConversationSource } from './conversations'
