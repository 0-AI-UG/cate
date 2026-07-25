export const BROWSER_PASSWORD_MANAGER_URL = 'chrome://password-manager/passwords'

export function isBrowserInternalPage(url: string): boolean {
  return url === BROWSER_PASSWORD_MANAGER_URL
}

export function browserInternalPageTitle(url: string): string {
  return url === BROWSER_PASSWORD_MANAGER_URL ? 'Password manager' : ''
}
