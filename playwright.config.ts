import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // perf-stress asserts FPS / spawn-rate thresholds that depend on the host's
  // raw speed, so it's a local regression tool, not a CI gate. CI sets
  // E2E_SKIP_PERF=1 to run only the functional (smoke/drag/dock) specs.
  testIgnore: process.env.E2E_SKIP_PERF ? ['**/perf-stress.spec.ts'] : [],
  timeout: 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  // The windowless e2e harness throttles the renderer's rAF loop, which makes a
  // few node-creation / animation-settle waits timing-sensitive. Retry twice on
  // CI so a transient timing flake doesn't redden an otherwise-green run; locally
  // keep 0 so flakes surface immediately.
  retries: process.env.CI ? 2 : 0,
  reporter: [['list']],
  projects: [{ name: 'electron' }],
})
