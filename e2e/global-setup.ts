// The suite runs the built app: fail early, with the fix, when it is missing.
import { existsSync } from 'node:fs'
import path from 'node:path'

export default function globalSetup(): void {
  const root = path.resolve(__dirname, '..')
  const missing = [
    ['dist/main/shell.js', 'npm run build'],
    ['dist-runtime/runtime.cjs', 'npm run build:runtime'],
  ].filter(([file]) => !existsSync(path.join(root, file!)))
  if (missing.length) {
    throw new Error(`e2e needs the built app: ${missing.map(([file, fix]) => `${file} (${fix})`).join(', ')}`)
  }
}
