// =============================================================================
// installPlanMode — copy the bundled cate-plan-mode extension into a
// workspace's cate-agent extensions dir on first use, where pi auto-discovers it.
//
// Source lives in our own tree at src/cateAgent/extensions/cate-plan-mode/. Pi
// loads .ts directly via jiti, so we just ship the raw .ts and .json files.
//
// Dev:  src/ is on disk under app.getAppPath().
// Prod: src/cateAgent/extensions/cate-plan-mode/ is copied into resources via
//       electron-builder.yml `extraResources`, so we resolve from
//       process.resourcesPath there.
//
// The SOURCE bundle is always read locally with node fs (it ships inside the
// app). Each DESTINATION is written THROUGH the runtime (local fs for the
// local runtime, the daemon for a remote one), so remote workspaces are
// seeded too. The host copy is overwritten only when it differs from the
// bundled source, so shipped updates reach hosts that already have an older
// copy without rewriting on every launch.
// =============================================================================

import { createBundledExtensionInstaller } from './extensionInstall'

export const installPlanModeExtension =
  createBundledExtensionInstaller('cate-plan-mode', '[installPlanMode]')
