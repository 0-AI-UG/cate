// =============================================================================
// installCanvasMode — copy the bundled cate-canvas-mode extension into a
// workspace's Cate agent directory. Mirrors the plan/ask-user installers.
// =============================================================================

import { createBundledExtensionInstaller } from './extensionInstall'

export const installCanvasModeExtension =
  createBundledExtensionInstaller('cate-canvas-mode', '[installCanvasMode]')
