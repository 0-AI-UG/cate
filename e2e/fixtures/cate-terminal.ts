// Running shell commands in a real Cate terminal and reading their output back
// from the runtime's screen (between printed markers).

import { expect, type Page } from '@playwright/test'

export function shellQuote(value: string): string {
  if (process.platform === 'win32') return `'${value.replace(/'/g, "''")}'`
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function cate(...args: string[]): string {
  return `cate ${args.map(shellQuote).join(' ')}`
}

let sequence = 0

/** Runs `command` in the terminal panel; resolves its exit code and output. */
export async function runInTerminal(page: Page, panelId: string, command: string, timeout = 20_000): Promise<{ code: number; output: string }> {
  const n = ++sequence
  const begin = `__CATE_BEGIN_${n}__`
  const end = `__CATE_END_${n}__`
  const wrapped = process.platform === 'win32'
    ? `Write-Output ("__CATE_{0}_${n}__" -f "BEGIN"); ${command}; $cateStatus=$LASTEXITCODE; Write-Output ("__CATE_{0}_${n}__:{1}" -f "END",$cateStatus)\r`
    : `printf '\\n__CATE_%s_${n}__\\n' BEGIN; ${command}; cate_status=$?; printf '\\n__CATE_%s_${n}__:%s\\n' END "$cate_status"\r`
  await page.evaluate(({ id, data }) => window.__cateE2E!.writeTerminal(id, data), { id: panelId, data: wrapped })
  const read = () => page.evaluate((id) => window.__cateE2E!.terminalText(id), panelId)
  await expect.poll(read, { timeout }).toMatch(new RegExp(`${end}:\\d+`))
  const screen = await read()
  const endMatch = screen.match(new RegExp(`${end}:(\\d+)`))!
  const endAt = screen.lastIndexOf(endMatch[0])
  const beginAt = screen.lastIndexOf(begin, endAt)
  expect(beginAt, screen).toBeGreaterThanOrEqual(0)
  return { code: Number(endMatch[1]), output: screen.slice(beginAt + begin.length, endAt).trim() }
}

/** Runs `cate <args>` and expects exit code 0. */
export async function runCate(page: Page, panelId: string, ...args: string[]): Promise<string> {
  const result = await runInTerminal(page, panelId, cate(...args))
  expect(result.code, `${args.join(' ')}\n${result.output}`).toBe(0)
  return result.output
}
