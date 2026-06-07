export type Lang = 'en' | 'ko'

const strings = {
  // Settings window sections
  'settings.title': { en: 'Settings', ko: '설정' },
  'settings.search': { en: 'Search settings…', ko: '설정 검색…' },
  'settings.section.general': { en: 'General', ko: '일반' },
  'settings.section.appearance': { en: 'Appearance', ko: '외관' },
  'settings.section.canvas': { en: 'Canvas', ko: '캔버스' },
  'settings.section.terminal': { en: 'Terminal', ko: '터미널' },
  'settings.section.browser': { en: 'Browser', ko: '브라우저' },
  'settings.section.sidebar': { en: 'Sidebar', ko: '사이드바' },
  'settings.section.fileExplorer': { en: 'File Explorer', ko: '파일 탐색기' },
  'settings.section.shortcuts': { en: 'Shortcuts', ko: '단축키' },
  'settings.section.notifications': { en: 'Notifications', ko: '알림' },
  'settings.section.updates': { en: 'Updates', ko: '업데이트' },

  // General settings
  'general.language': { en: 'Language', ko: '언어' },
  'general.language.desc': { en: 'Interface language.', ko: '인터페이스 언어.' },
  'general.shell': { en: 'Default shell', ko: '기본 셸' },
  'general.shell.desc': { en: 'Leave blank to auto-detect from $SHELL.', ko: '비워두면 $SHELL에서 자동 감지합니다.' },
  'general.warnQuit': { en: 'Warn before quitting', ko: '종료 전 경고' },
  'general.warnQuit.desc': { en: 'Show a confirmation dialog when quitting Cate.', ko: 'Cate 종료 시 확인 대화상자 표시.' },

  // Canvas settings
  'canvas.zoomSpeed': { en: 'Zoom speed', ko: '확대/축소 속도' },
  'canvas.autoFocus': { en: 'Auto-focus largest visible panel', ko: '가장 큰 패널 자동 포커스' },
  'canvas.autoFocus.desc': { en: 'Activate the panel filling the most visible area as you pan and zoom.', ko: '이동하거나 확대/축소 시 가장 많이 보이는 패널을 자동으로 활성화합니다.' },
  'canvas.snapToGrid': { en: 'Snap to grid', ko: '그리드에 맞추기' },
  'canvas.snapToGrid.desc': { en: 'Align panels to the grid while dragging and resizing. Hold Alt to bypass.', ko: '드래그 및 크기 조정 시 그리드에 맞춥니다. Alt 키를 누르면 비활성화.' },
  'canvas.placementPicker': { en: 'Recommend where new panels go', ko: '새 패널 위치 추천' },
  'canvas.placementPicker.desc': { en: 'On Cmd+T or a toolbar click, show numbered spots to pick from. Off places panels automatically.', ko: 'Cmd+T 또는 도구 모음 클릭 시 번호가 매겨진 위치를 표시합니다. 비활성화하면 자동 배치.' },
  'canvas.background': { en: 'Canvas background', ko: '캔버스 배경' },
  'canvas.backgroundImage': { en: 'Background image', ko: '배경 이미지' },
  'canvas.backgroundOpacity': { en: 'Background image opacity', ko: '배경 이미지 불투명도' },
  'canvas.defaultWidth': { en: 'Default panel width', ko: '기본 패널 너비' },
  'canvas.defaultHeight': { en: 'Default panel height', ko: '기본 패널 높이' },
  'canvas.autoLayoutMode': { en: 'Auto Layout mode', ko: '자동 배치 모드' },
  'canvas.autoLayoutMode.desc': { en: 'Layout applied when using Auto Layout (⌘⇧L).', ko: '자동 배치(⌘⇧L) 사용 시 적용되는 레이아웃.' },
  'canvas.autoLayoutMode.grid': { en: 'Adaptive Grid', ko: '적응형 격자' },
  'canvas.autoLayoutMode.columns': { en: '2 Columns', ko: '2열' },
  'canvas.autoLayoutMode.rows': { en: '2 Rows', ko: '2행' },
  'canvas.choose': { en: 'Choose…', ko: '선택…' },
  'canvas.change': { en: 'Change…', ko: '변경…' },
  'canvas.clear': { en: 'Clear', ko: '지우기' },

  // File Explorer settings
  'fileExplorer.openMode': { en: 'Open files in', ko: '파일 열기 방식' },
  'fileExplorer.openMode.desc': { en: 'Where files open when double-clicked in the file explorer.', ko: '파일 탐색기에서 더블클릭 시 파일이 열리는 위치.' },
  'fileExplorer.openMode.dock': { en: 'Dock Tab', ko: '도크 탭' },
  'fileExplorer.openMode.canvas': { en: 'Canvas Panel', ko: '캔버스 패널' },
  'fileExplorer.exclusions': { en: 'Names hidden from the explorer, search, and file watching, in every project.', ko: '모든 프로젝트에서 탐색기, 검색, 파일 감시에서 숨겨지는 이름.' },
  'fileExplorer.addPlaceholder': { en: 'Add a name, e.g. dist', ko: '이름 추가, 예: dist' },
  'fileExplorer.add': { en: 'Add', ko: '추가' },
  'fileExplorer.noExclusions': { en: 'No exclusions. Every file and folder is shown.', ko: '제외 없음. 모든 파일과 폴더가 표시됩니다.' },
  'fileExplorer.restoreDefaults': { en: 'Restore defaults', ko: '기본값 복원' },
  'fileExplorer.error.path': { en: 'Enter a single folder or file name, not a path.', ko: '경로가 아닌 단일 폴더 또는 파일 이름을 입력하세요.' },
  'fileExplorer.error.glob': { en: 'Names cannot contain wildcard characters like * ? [ ] { } ( ) !.', ko: '이름에 * ? [ ] { } ( ) ! 같은 와일드카드 문자를 포함할 수 없습니다.' },
  'fileExplorer.error.duplicate': { en: 'is already excluded.', ko: '이미 제외되어 있습니다.' },

  // Terminal settings
  'terminal.fontFamily': { en: 'Font family', ko: '글꼴 패밀리' },
  'terminal.fontFamily.desc': { en: 'Leave blank to use the system monospace font.', ko: '비워두면 시스템 고정폭 글꼴을 사용합니다.' },
  'terminal.fontSize': { en: 'Font size', ko: '글꼴 크기' },
  'terminal.scrollback': { en: 'Scrollback buffer', ko: '스크롤백 버퍼' },
  'terminal.scrollback.desc': { en: 'lines', ko: '줄' },
  'terminal.scrollSpeed': { en: 'Scroll speed', ko: '스크롤 속도' },
  'terminal.contrast': { en: 'Text contrast', ko: '텍스트 대비' },
  'terminal.cursorBlink': { en: 'Blink cursor', ko: '커서 깜빡임' },
  'terminal.optionMeta': { en: 'Option key as Meta', ko: 'Option 키를 Meta로' },
  'terminal.optionMeta.desc': { en: 'Makes Option behave like Alt/Meta for keyboard shortcuts in terminal programs.', ko: 'Option 키를 터미널 프로그램의 Alt/Meta로 사용합니다.' },
  'terminal.autoSuspend': { en: 'Auto-suspend idle terminals', ko: '유휴 터미널 자동 일시 정지' },
  'terminal.autoSuspend.desc': { en: 'Pause terminals with no running process to save memory. Resumes instantly on focus.', ko: '실행 중인 프로세스가 없는 터미널을 일시 정지하여 메모리를 절약합니다. 포커스 시 즉시 재개.' },

  // Browser settings
  'browser.homepage': { en: 'Homepage', ko: '홈페이지' },
  'browser.searchEngine': { en: 'Search engine', ko: '검색 엔진' },
  'browser.linkTarget': { en: 'Open terminal links in', ko: '터미널 링크 열기' },
  'browser.linkTarget.ask': { en: 'Ask every time', ko: '매번 물어보기' },
  'browser.linkTarget.browser': { en: 'Browser panel', ko: '브라우저 패널' },
  'browser.linkTarget.external': { en: 'Default browser', ko: '기본 브라우저' },

  // Sidebar settings
  'sidebar.tintOpacity': { en: 'Sidebar tint opacity', ko: '사이드바 색조 불투명도' },
  'sidebar.showOnLaunch': { en: 'Show file explorer on launch', ko: '실행 시 파일 탐색기 표시' },

  // Appearance settings
  'appearance.theme': { en: 'Color theme', ko: '색상 테마' },
  'appearance.fontSize': { en: 'Editor font size', ko: '편집기 글꼴 크기' },

  // Notification settings
  'notifications.enable': { en: 'Enable notifications', ko: '알림 활성화' },
  'notifications.enable.desc': { en: 'Allow Cate to show macOS notifications for agent completions and other events.', ko: 'Cate가 에이전트 완료 및 기타 이벤트에 대한 macOS 알림을 표시하도록 허용합니다.' },
  'notifications.unfocused': { en: 'Only when unfocused', ko: '포커스 없을 때만' },
  'notifications.unfocused.desc': { en: 'Suppress notifications while Cate is the active application.', ko: 'Cate가 활성 응용 프로그램인 동안 알림을 억제합니다.' },

  // Updates settings
  'updates.beta': { en: 'Beta updates', ko: '베타 업데이트' },
  'updates.beta.desc': { en: 'Include pre-release builds in automatic updates.', ko: '자동 업데이트에 사전 릴리스 빌드를 포함합니다.' },

  // Shortcuts settings
  'shortcuts.reset': { en: 'Reset all shortcuts', ko: '모든 단축키 초기화' },
  'shortcuts.resetConfirm': { en: 'Reset shortcuts?', ko: '단축키를 초기화할까요?' },
  'shortcuts.resetConfirm.desc': { en: 'All shortcuts will be reset to their defaults.', ko: '모든 단축키가 기본값으로 초기화됩니다.' },
  'shortcuts.resetConfirm.yes': { en: 'Reset', ko: '초기화' },
  'shortcuts.resetConfirm.no': { en: 'Cancel', ko: '취소' },

  // Common
  'common.on': { en: 'On', ko: '켜기' },
  'common.off': { en: 'Off', ko: '끄기' },
  'common.save': { en: 'Save', ko: '저장' },
  'common.cancel': { en: 'Cancel', ko: '취소' },
  'common.close': { en: 'Close', ko: '닫기' },
} as const

export type StringKey = keyof typeof strings

export function t(key: StringKey, lang: Lang): string {
  return strings[key][lang] ?? strings[key]['en']
}

export { strings }
