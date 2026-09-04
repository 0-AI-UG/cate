export const BROWSER_PASSWORD_MANAGER_URL = 'chrome://password-manager/passwords'
export const BROWSER_HISTORY_URL = 'chrome://history/'

export function isBrowserInternalPage(url: string): boolean {
  return url === BROWSER_PASSWORD_MANAGER_URL || url === BROWSER_HISTORY_URL
}

export function browserInternalPageTitle(url: string): string {
  if (url === BROWSER_PASSWORD_MANAGER_URL) return 'Password manager'
  if (url === BROWSER_HISTORY_URL) return 'History'
  return ''
}
