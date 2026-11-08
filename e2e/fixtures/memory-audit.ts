// Counts the app and detached workspace daemons without including the test runner.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from 'playwright'

export async function memoryAudit(app: ElectronApplication, page: Page, home: string) {
  const samples: Array<{ scenario: string; at: number; totalRssMiB: number; runtimePids: number[]; processes: Array<{ pid: number; ppid: number; rssMiB: number; command: string }>; electron: unknown; rendererHeap: unknown }> = []
  const cdp = await page.context().newCDPSession(page)
  const sample = async (scenario: string) => {
    await page.waitForTimeout(2500)
    for (let i = 0; i < 5; i++) {
      const runtimeDir = path.join(home, '.cate/workspaces')
      let runtimePids: number[] = []
      try {
        runtimePids = readdirSync(runtimeDir).flatMap(id => {
          try { return [JSON.parse(readFileSync(path.join(runtimeDir, id, 'runtime.json'), 'utf8')).pid as number] } catch { return [] }
        })
      } catch { /* no workspace yet */ }
      const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' }).trim().split('\n').map(line => {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/)!
        return { pid: +m[1], ppid: +m[2], rssMiB: +m[3] / 1024, command: m[4] }
      })
      const roots = [app.process().pid!, ...runtimePids]
      const included = new Set(roots)
      let size = 0
      while (size !== included.size) {
        size = included.size
        for (const row of rows) if (included.has(row.ppid)) included.add(row.pid)
      }
      const processes = rows.filter(row => included.has(row.pid))
      const electron = await app.evaluate(({ app, webContents }) => ({
        metrics: app.getAppMetrics(),
        contents: webContents.getAllWebContents().map(w => ({ pid: w.getOSProcessId(), type: w.getType(), url: w.getURL() })),
        heap: process.memoryUsage(),
      }))
      const heap = await cdp.send('Runtime.getHeapUsage')
      samples.push({ scenario, at: Date.now(), totalRssMiB: processes.reduce((sum, p) => sum + p.rssMiB, 0), runtimePids, processes, electron, rendererHeap: heap })
      await page.waitForTimeout(500)
    }
    console.log('RAM scenario completed:', scenario)
  }
  return { samples, sample }
}
