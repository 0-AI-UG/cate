import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DATA_FILES } from '../contract'

/** Absolute paths of everything in one workspace data directory. */
export function dataPaths(dataDir: string) {
  const at = (name: string) => path.join(dataDir, name)
  return {
    dir: dataDir,
    socket: at(DATA_FILES.socket),
    runtimeInfo: at(DATA_FILES.runtimeInfo),
    document: at(DATA_FILES.document),
    sessions: at(DATA_FILES.sessions),
    session: (panelId: string) => path.join(dataDir, DATA_FILES.sessions, `${safeName(panelId)}.json`),
    buffers: at(DATA_FILES.buffers),
    buffer: (hash: string) => path.join(dataDir, DATA_FILES.buffers, `${safeName(hash)}.bin`),
    settings: at(DATA_FILES.settings),
    secrets: at(DATA_FILES.secrets),
    devices: at(DATA_FILES.devices),
    push: at(DATA_FILES.push),
    trust: at(DATA_FILES.trust),
    grants: at(DATA_FILES.grants),
    skills: at(DATA_FILES.skills),
    skillSources: at(DATA_FILES.skillSources),
    browser: at(DATA_FILES.browser),
    downloads: path.join(dataDir, DATA_FILES.browser, 'downloads'),
    t3: at(DATA_FILES.t3),
    agents: at(DATA_FILES.agents),
    terminalLogs: at(DATA_FILES.terminalLogs),
    screenshots: at(DATA_FILES.screenshots),
    logs: at(DATA_FILES.logs),
  }
}

export type DataPaths = ReturnType<typeof dataPaths>

function safeName(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') throw new Error(`invalid file name '${name}'`)
  return name
}

/** Creates the directory with mode 0700, tightening it if it already exists. */
export async function ensureDataDir(dataDir: string): Promise<DataPaths> {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 })
  await fs.chmod(dataDir, 0o700)
  return dataPaths(dataDir)
}
