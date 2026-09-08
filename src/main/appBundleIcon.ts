import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const execFileAsync = promisify(execFile)
const icons = new Map<string, Promise<string>>()

/** Read the application's own icon, not the generic icon associated with .app. */
export function appBundleIcon(appPath: string): Promise<string> {
  const cached = icons.get(appPath)
  if (cached) return cached
  const result = readBundleIcon(appPath).catch(() => '')
  icons.set(appPath, result)
  return result
}

async function readBundleIcon(appPath: string): Promise<string> {
  const { stdout } = await execFileAsync('/usr/bin/plutil', [
    '-extract', 'CFBundleIconFile', 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist'),
  ], { timeout: 5000 })
  const name = path.basename(stdout.trim())
  if (!name) return ''
  const source = path.join(appPath, 'Contents', 'Resources', name.endsWith('.icns') ? name : `${name}.icns`)
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cate-app-icon-'))
  const output = path.join(directory, 'icon.png')
  try {
    await execFileAsync('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '64', source, '--out', output], { timeout: 5000 })
    return `data:image/png;base64,${(await fs.readFile(output)).toString('base64')}`
  } finally {
    await fs.unlink(output).catch(() => {})
    await fs.rmdir(directory).catch(() => {})
  }
}
