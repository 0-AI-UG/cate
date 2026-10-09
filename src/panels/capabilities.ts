// Every capability declaration a client builds its typed runtime proxy from,
// handed to each connection by the shell's boot. The one list: a module that
// registers a capability adds it here, and the check below fails to compile
// until it does.

import type { CapabilityRegistry } from '@kernel/rpc/contract'
import { apiCapability } from '@kernel/api/contract/capability'
import { settingsCapability } from '@kernel/settings/contract/capability'
import { runtimeCapability } from '@runtime/daemon/contract/capability'
import { pairingCapability } from '@runtime/pairing/contract/capability'
import { powerCapability } from '@runtime/power/contract/capability'
import { pushCapability } from '@runtime/push/contract/capability'
import { serverCapability } from '@runtime/server/contract/capability'
import { tunnelCapability } from '@runtime/tunnel/contract/capability'
import { documentCapability, presenceCapability } from '@workspace/document/contract/capability'
import { workspaceCapability } from '@workspace/lifecycle/contract/capability'
import { fileCapability, searchCapability } from '@workspace/files/contract/capability'
import { vcsCapability } from '@workspace/repository/contract/capability'
import { skillsCapability } from '@workspace/skills/contract/capability'
import { agentsCapability } from '@services/agents/contract/capability'
import { browserDataCapability } from '@services/browser/contract/capability'
import { t3Capability } from '@services/t3/contract/capability'
import { processCapability } from '@services/terminal/contract/capability'
import { sessionCapability, surfaceCapability } from '@panels/framework/contract/capability'
import { browserCodeCapability } from '@panels/browser/contract/capability'

export const RUNTIME_CAPABILITIES = [
  apiCapability,
  settingsCapability,
  runtimeCapability,
  pairingCapability,
  powerCapability,
  pushCapability,
  serverCapability,
  tunnelCapability,
  documentCapability,
  presenceCapability,
  workspaceCapability,
  fileCapability,
  searchCapability,
  vcsCapability,
  skillsCapability,
  agentsCapability,
  browserDataCapability,
  t3Capability,
  processCapability,
  sessionCapability,
  surfaceCapability,
  browserCodeCapability,
] as const

type Listed = (typeof RUNTIME_CAPABILITIES)[number]['name']
type Unlisted = Exclude<keyof CapabilityRegistry, Listed>

// A registered capability missing from the list names itself in this error.
const complete: [Unlisted] extends [never] ? true : { missing: Unlisted } = true
void complete
