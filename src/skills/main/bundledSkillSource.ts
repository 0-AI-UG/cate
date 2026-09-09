import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
/** Shared development/packaged source discovery; installation scope stays with callers. */
export function bundledSkillSource(name: string): string | null {
  return [path.join(app.getAppPath(), 'skills', name), path.join(process.resourcesPath ?? '', 'skills', name)]
    .find(candidate => fs.existsSync(candidate)) ?? null
}
