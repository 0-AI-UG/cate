import type { Theme, AppColorKey } from '../../shared/theme'
import { mergeThemeApp } from '../../shared/themeResolution'

// T3's semantic tokens, mapped to the same resolved palette as Cate's chrome.
const APP_TOKENS: Record<string, AppColorKey> = {
  background: 'surface-4', foreground: 'text-primary',
  'app-chrome-background': 'surface-1',
  'toolbar-background': 'surface-2', 'toolbar-foreground': 'text-primary',
  'toolbar-border': 'border-subtle', 'toolbar-control': 'surface-3',
  'toolbar-control-foreground': 'text-primary', 'toolbar-control-hover': 'surface-hover',
  card: 'surface-3', 'card-foreground': 'text-primary',
  popover: 'surface-2', 'popover-foreground': 'text-primary',
  'surface-raised': 'surface-3',
  primary: 'focus-blue', 'primary-foreground': 'text-inverse',
  secondary: 'surface-2', 'secondary-foreground': 'text-secondary',
  muted: 'surface-3', 'muted-foreground': 'text-muted',
  placeholder: 'text-muted', 'secondary-label': 'text-secondary', 'icon-muted': 'text-muted',
  accent: 'surface-hover', 'accent-foreground': 'text-primary',
  'message-surface': 'surface-2', 'message-foreground': 'text-primary',
  'message-action': 'focus-blue', 'message-action-foreground': 'text-inverse',
  'message-action-hover': 'focus-blue',
  border: 'border-subtle', input: 'border-strong', ring: 'border-focus',
  error: 'git-deleted', 'error-foreground': 'git-deleted',
  destructive: 'git-deleted', 'destructive-foreground': 'git-deleted',
  warning: 'activity-orange', 'warning-foreground': 'activity-orange',
  success: 'activity-green', 'success-foreground': 'activity-green',
  info: 'focus-blue', 'info-foreground': 'focus-blue',
  update: 'focus-blue', 'update-foreground': 'focus-blue',
  'code-background': 'surface-1', 'code-foreground': 'text-primary',
}

// Some composer styles use the upstream theme palette directly.
const PALETTE_ALIASES: Record<string, string> = {
  canvas: 'background', text: 'foreground', 'text-muted': 'muted-foreground',
  chrome: 'app-chrome-background', toolbar: 'toolbar-background',
  surface: 'card', 'surface-overlay': 'popover',
  'accent-surface': 'accent', 'accent-surface-foreground': 'accent-foreground', focus: 'ring',
}

export function agentHarnessThemeScript(theme: Theme): string {
  const app = mergeThemeApp(theme)
  const tokens = Object.fromEntries(Object.entries(APP_TOKENS).map(([key, value]) => [key, app[value]]))
  for (const key of ['error', 'warning', 'update']) {
    tokens[`${key}-surface`] = `color-mix(in srgb, ${tokens[key]} 12%, transparent)`
  }
  tokens['terminal-background'] = theme.terminal.background
  tokens['terminal-foreground'] = theme.terminal.foreground
  tokens['terminal-cursor'] = theme.terminal.cursor ?? theme.terminal.foreground
  tokens['terminal-selection-background'] = theme.terminal.selectionBackground ?? app['surface-hover-strong']
  const declarations = Object.entries(tokens).flatMap(([key, value]) => [
    `--${key}: ${value} !important;`, `--app-theme-${key}: ${value} !important;`,
  ])
  for (const [alias, token] of Object.entries(PALETTE_ALIASES)) {
    declarations.push(`--app-theme-${alias}: ${tokens[token]} !important;`)
  }
  const css = `:root { color-scheme: ${theme.type} !important; ${declarations.join('\n')} }`
  return `(() => {
    const root = document.documentElement;
    let style = document.getElementById('cate-agent-theme');
    if (!style) {
      style = document.createElement('style');
      style.id = 'cate-agent-theme';
      document.head.appendChild(style);
    }
    style.textContent = ${JSON.stringify(css)};
    window.__cateThemeObserver?.disconnect();
    const applyAppearance = () => {
      if (root.classList.contains('dark') !== ${theme.type === 'dark'}) root.classList.toggle('dark', ${theme.type === 'dark'});
      if (root.classList.contains('light') !== ${theme.type === 'light'}) root.classList.toggle('light', ${theme.type === 'light'});
      if (root.dataset.themeId !== 'cate') root.dataset.themeId = 'cate';
    };
    applyAppearance();
    // Upstream initializes its own persisted/system theme after dom-ready.
    // Keep Cate authoritative without altering T3's saved preferences.
    window.__cateThemeObserver = new MutationObserver(applyAppearance);
    window.__cateThemeObserver.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme-id'] });
    root.dataset.cateTheme = ${JSON.stringify(theme.id)};
  })()`
}
