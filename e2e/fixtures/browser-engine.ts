import type { ElectronApplication } from 'playwright'
import type { createBrowserEngineHost } from '../../src/services/browser/desktop/engine/host'
declare global { var __cateBrowserEngineTest: ReturnType<typeof createBrowserEngineHost> }

/** Test-only native engine oracle, outside the public page-control API.
 *  `webContents.fromId` resolves opaque page handles in the helper. */
export async function engineEvaluate<T, A = undefined>(app: ElectronApplication, fn: (electron: typeof import('electron'), args: A) => T | Promise<T>, args?: A): Promise<T> {
  return app.evaluate((_, input) => globalThis.__cateBrowserEngineTest.call<T>('nativeTest', input), { fn: String(fn), args })
}
