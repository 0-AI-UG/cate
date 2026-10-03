export {
  createTerminalService,
  nodePtySpawn,
  type TerminalService,
  type TerminalServiceDeps,
  type TerminalSettingsReader,
  type TerminalSettingValues,
  type PtyProcess,
  type PtySpawner,
  type ResolvedShell,
  type ViewerSink,
} from './terminalService'
export { processCapabilityImpl } from './capability'
export type {
  ActivityObserver,
  ActivityScan,
  EnvContributor,
  ExitObserver,
  InputObserver,
  LaunchCommand,
  LaunchPlan,
  LaunchResolver,
  OutputObserver,
  SpawnInfo,
} from './extensions'
export { cateCliEnvContributor, cateBinDir, prependPath, type CateCliEnvOptions } from './cateCli'
export { applyLoginEnv, captureLoginEnv, sanitizeEnv, LOGIN_ENV_MARKER } from './loginEnv'
export { resolveShell, isExecutable, type ResolvedShell as HostShell } from './shellResolver'
export { snapshotProcessTree, activityForPid, systemScanner, type ProcTree, type ProcessScanner } from './procScan'
