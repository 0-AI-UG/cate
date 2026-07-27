// =============================================================================
// installAskUser — copy the bundled cate-ask-user extension into a workspace's
// cate-agent extensions dir on first use, where pi auto-discovers it. Mirrors
// installPlanMode exactly (same dev/prod source resolution, same runtime-aware
// copy-if-changed semantics so a shipped update reaches hosts with an older copy).
// =============================================================================

import { createBundledExtensionInstaller } from './extensionInstall'

export const installAskUserExtension =
  createBundledExtensionInstaller('cate-ask-user', '[installAskUser]')
