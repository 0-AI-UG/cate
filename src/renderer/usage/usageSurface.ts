import type { Theme } from '../../shared/theme'
import { mergeThemeApp } from '../../shared/themeResolution'
import { agentHarnessThemeScript } from '../lib/agentHarnessTheme'

export function usageThemeScript(theme: Theme, fontFamily: string): string {
  const app = mergeThemeApp(theme)
  return agentHarnessThemeScript({ ...theme, app: { ...theme.app, 'surface-4': app['canvas-bg'] } })
    + `;document.documentElement.style.setProperty('--cate-ui-font', ${JSON.stringify(fontFamily)});`
}

/** Keep upstream controls and behavior, with Cate's canvas surface and chrome. */
export const USAGE_SURFACE_CSS = `
/* Cate owns the overlay title. Keep the upstream environment filter and actions. */
nav[aria-label="Usage breadcrumb"] > ol > li:has(> h1),
nav[aria-label="Usage breadcrumb"] > ol > li[aria-hidden="true"] {
  display: none !important;
}

:root {
  --text-xs: 12px !important;
  --text-sm: 13px !important;
  --text-base: 13px !important;
}
body, button, input, select, textarea {
  font-family: var(--cate-ui-font) !important;
}
body { font-size: 13px; line-height: 1.5; }
/* Embedded Usage does not own T3 app notifications or provider updates. */
[data-slot="toast-viewport"],
[data-slot="toast-viewport-anchored"] {
  display: none !important;
}
[data-slot="sidebar-inset"] header {
  min-height: 44px !important;
  padding-inline: 24px !important;
}
[data-slot="sidebar-inset"] header h1,
[data-slot="sidebar-inset"] header nav,
[data-slot="sidebar-inset"] header nav button {
  font-size: 13px !important;
  line-height: 20px !important;
}
[data-slot="sidebar-inset"] h2 { font-size: 14px !important; }
[data-slot="sidebar-inset"] table { font-size: 13px !important; }
[data-slot="sidebar-inset"] th { font-size: 12px !important; }
[data-slot="sidebar-inset"] .text-4xl { font-size: 32px !important; line-height: 40px !important; }
header button[aria-label^="Refresh"] {
  width: 28px !important;
  height: 28px !important;
}
header button[aria-label^="Refresh"] svg { width: 14px; height: 14px; }

[data-slot="sidebar-inset"] > div > header {
  height: 44px !important;
  min-height: 44px !important;
  padding: 0 24px !important;
  display: flex !important;
  align-items: center !important;
}
[data-slot="sidebar-inset"] header > div {
  width: 100%;
  align-items: center !important;
}
[data-slot="toggle-group"][data-variant="segmented"] {
  background: color-mix(in srgb, var(--foreground) 5%, var(--background)) !important;
  border: 1px solid color-mix(in srgb, var(--foreground) 4%, transparent);
  border-radius: 8px !important;
  padding: 2px !important;
  gap: 1px !important;
}
[data-slot="toggle-group"][data-variant="segmented"] [data-slot="toggle"] {
  border-radius: 6px !important;
  height: 24px !important;
  min-height: 24px !important;
  padding-inline: 9px !important;
  font-size: 12px !important;
  line-height: 16px !important;
  font-weight: 500 !important;
  color: var(--muted-foreground);
  transition: background 150ms, color 150ms, box-shadow 150ms;
}
[data-slot="toggle-group"] [data-slot="toggle"][data-pressed] {
  background: color-mix(in srgb, var(--foreground) 10%, var(--background)) !important;
  color: var(--foreground) !important;
  box-shadow: 0 1px 3px #00000018, inset 0 1px color-mix(in srgb, var(--foreground) 5%, transparent) !important;
}
[data-slot="toggle-group"] [data-slot="toggle"]:hover:not([data-pressed]) {
  background: color-mix(in srgb, var(--foreground) 5%, transparent) !important;
  color: var(--foreground);
}
@media (min-width: 900px) {
  [data-slot="sidebar-inset"] header > div {
    display: flex !important;
    flex-wrap: nowrap;
    padding-block: 0 !important;
  }
  header div:has(> [data-slot="toggle-group"][aria-label="Usage metric"]) {
    display: flex !important;
  }
  header div:has(> button[aria-label="Usage metric"]) {
    display: none !important;
  }
}
`
