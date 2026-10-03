// IPC channel names of the desktop shell. Literal strings in a pure module so
// the preload bundles them inline (a shared chunk breaks the sandboxed preload).

export const DESKTOP_CHANNELS = {
  appInfo: 'cate-desktop:app:info',
  appAttention: 'cate-desktop:app:attention',

  deviceGet: 'cate-desktop:device:get',
  deviceSet: 'cate-desktop:device:set',
  deviceChanged: 'cate-desktop:device:changed',

  windowsOpen: 'cate-desktop:windows:open',
  windowsClose: 'cate-desktop:windows:close',
  windowsFocus: 'cate-desktop:windows:focus',
  windowsList: 'cate-desktop:windows:list',
  windowNewMain: 'cate-desktop:window:new-main',
  windowMinimize: 'cate-desktop:window:minimize',
  windowToggleMaximize: 'cate-desktop:window:toggle-maximize',
  windowClose: 'cate-desktop:window:close',
  windowSetTitle: 'cate-desktop:window:set-title',
  windowState: 'cate-desktop:window:state',
  windowStateChanged: 'cate-desktop:window:state-changed',
  windowBounds: 'cate-desktop:window:bounds',
  windowCloseRequested: 'cate-desktop:window:close-requested',
  anyFullscreen: 'cate-desktop:window:any-fullscreen',

  menuContext: 'cate-desktop:menu:context',
  menuBarItems: 'cate-desktop:menu:bar-items',
  menuPopupBarItem: 'cate-desktop:menu:popup-bar-item',
  menuNativeAction: 'cate-desktop:menu:native-action',
  menuAction: 'cate-desktop:menu:action',
  menuSetModel: 'cate-desktop:menu:set-model',
  browserShortcut: 'cate-desktop:menu:browser-shortcut',

  dialogMessageBox: 'cate-desktop:dialog:message-box',
  dialogOpen: 'cate-desktop:dialog:open',
  canvasBackgroundPick: 'cate-desktop:canvas-background:pick',
  canvasBackgroundRead: 'cate-desktop:canvas-background:read',
  canvasBackgroundPrune: 'cate-desktop:canvas-background:prune',

  osOpenExternal: 'cate-desktop:os:open-external',
  osOpenSettingsFile: 'cate-desktop:os:open-settings-file',
  clipboardWrite: 'cate-desktop:clipboard:write',
  clipboardRead: 'cate-desktop:clipboard:read',
  notify: 'cate-desktop:notify',
  notificationAction: 'cate-desktop:notify:action',

  updateStatus: 'cate-desktop:update:status',
  updateGetStatus: 'cate-desktop:update:get-status',
  updateCheck: 'cate-desktop:update:check',
  updateInstall: 'cate-desktop:update:install',

  analyticsTrack: 'cate-desktop:analytics:track',
  analyticsFeedbackPending: 'cate-desktop:analytics:feedback-pending',
  analyticsFeedbackSubmit: 'cate-desktop:analytics:feedback-submit',
  analyticsFeedbackDismiss: 'cate-desktop:analytics:feedback-dismiss',
  analyticsFeedbackPrompt: 'cate-desktop:analytics:feedback-prompt',

  captureWindow: 'cate-desktop:capture:window',
  recentScreenshots: 'cate-desktop:capture:recent',
  recentScreenshotsChanged: 'cate-desktop:capture:recent-changed',
  recentScreenshotRead: 'cate-desktop:capture:recent-read',
  recentScreenshotDrag: 'cate-desktop:capture:recent-drag',
  recentScreenshotAddAnnotated: 'cate-desktop:capture:recent-add-annotated',

  dragStart: 'cate-desktop:drag:start',
  dragClaim: 'cate-desktop:drag:claim',
  dragEnd: 'cate-desktop:drag:end',
  dragCancel: 'cate-desktop:drag:cancel',
  dragPointer: 'cate-desktop:drag:pointer',
  dragEnded: 'cate-desktop:drag:ended',

  dialLocal: 'cate-desktop:transport:dial-local',
  dialNetwork: 'cate-desktop:transport:dial-network',
  dialLoopbackTcp: 'cate-desktop:transport:dial-loopback-tcp',
  pipePort: 'cate-desktop:transport:port',
  loopbackRequest: 'cate-desktop:transport:loopback-request',
  pair: 'cate-desktop:transport:pair',

  sshEnsureRuntime: 'cate-desktop:ssh:ensure-runtime',
  sshListDir: 'cate-desktop:ssh:list-dir',
  sshMkdir: 'cate-desktop:ssh:mkdir',
  sshServe: 'cate-desktop:ssh:serve',

  webPartition: 'cate-desktop:web:partition',
  webRelease: 'cate-desktop:web:release',
  webSetCookie: 'cate-desktop:web:set-cookie',

  webglRequest: 'cate-desktop:webgl:request',
  webglRelease: 'cate-desktop:webgl:release',

  quitBlockers: 'cate-desktop:lifecycle:quit-blockers',
  openPath: 'cate-desktop:lifecycle:open-path',
  openUrl: 'cate-desktop:lifecycle:open-url',
  openRequestsReady: 'cate-desktop:lifecycle:open-requests-ready',

  perfGet: 'cate-desktop:perf:get',
} as const

export type DesktopChannel = (typeof DESKTOP_CHANNELS)[keyof typeof DESKTOP_CHANNELS]
