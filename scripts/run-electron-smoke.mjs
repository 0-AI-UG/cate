// Launches the built desktop shell (package.json `main`) and lets main's
// CATE_SMOKE_TEST check the preload bridge and a round trip through main.
// CATE_E2E keeps the window unmapped and userData in a fresh temp dir.
import { spawn } from 'node:child_process'
import electron from 'electron'

const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CATE_E2E: process.env.CATE_E2E ?? '1',
    CATE_SMOKE_TEST: '1',
  },
})

child.on('exit', (code) => {
  process.exit(code ?? 1)
})
