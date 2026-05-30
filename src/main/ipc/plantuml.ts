import { ipcMain } from 'electron'
import { spawn } from 'child_process'
import { PLANTUML_RENDER } from '../../shared/ipc-channels'

const RENDER_TIMEOUT_MS = 15_000

/** Args for `java <args>` to render an SVG from stdin to stdout via -pipe. */
export function buildPlantumlArgs(jarPath: string): string[] {
  return ['-jar', jarPath, '-tsvg', '-pipe']
}

export interface PlantumlRenderResult {
  svg?: string
  error?: string
}

function renderLocal(source: string, jarPath: string): Promise<PlantumlRenderResult> {
  return new Promise((resolve) => {
    if (!jarPath.trim()) {
      resolve({ error: 'No PlantUML jar configured. Set one in Settings → Diagrams.' })
      return
    }
    let child
    try {
      child = spawn('java', buildPlantumlArgs(jarPath), { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch {
      resolve({ error: 'Could not start Java. Install a JRE or check it is on your PATH.' })
      return
    }

    const out: Buffer[] = []
    const err: Buffer[] = []
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ error: 'PlantUML rendering timed out.' })
    }, RENDER_TIMEOUT_MS)

    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => err.push(d))
    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      const msg = e.code === 'ENOENT'
        ? 'Java not found. Install a JRE or check it is on your PATH.'
        : `Failed to run PlantUML: ${e.message}`
      resolve({ error: msg })
    })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      const svg = Buffer.concat(out).toString('utf8')
      if (code === 0 && svg.includes('<svg')) {
        resolve({ svg })
      } else {
        const stderr = Buffer.concat(err).toString('utf8').trim()
        resolve({ error: stderr || `PlantUML exited with code ${code ?? 'unknown'}.` })
      }
    })

    child.stdin.write(source)
    child.stdin.end()
  })
}

export function registerHandlers(): void {
  ipcMain.handle(
    PLANTUML_RENDER,
    async (_event, source: string, jarPath: string): Promise<PlantumlRenderResult> => {
      try {
        return await renderLocal(source, jarPath)
      } catch (e) {
        return { error: e instanceof Error ? e.message : 'Unknown PlantUML error' }
      }
    },
  )
}
