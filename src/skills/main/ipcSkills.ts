// =============================================================================
// IPC handlers for the cross-agent skill manager. Thin wrappers over the
// registry (search), installer (install/uninstall/list), and sources stores.
// =============================================================================

import { ipcMain } from 'electron'
import log from '../../main/logger'
import {
  SKILLS_GET_INDEX,
  SKILLS_REFRESH,
  SKILLS_GET_PREVIEW,
  SKILLS_INSTALL,
  SKILLS_UNINSTALL,
  SKILLS_LIST_INSTALLED,
  SKILLS_LIST_SAVED,
  SKILLS_SAVE,
  SKILLS_UNSAVE,
  SKILLS_LIST_SOURCES,
  SKILLS_ADD_SOURCE,
  SKILLS_REMOVE_SOURCE,
  SKILLS_GET_TOKEN,
  SKILLS_SET_TOKEN,
} from '../../shared/ipc-channels'
import * as registry from './skillsRegistry'
import * as installer from './skillsInstaller'
import * as savedSkills from './savedSkills'
import * as sources from './skillSources'
import type { SkillEntry, SkillTargetId } from '../../shared/skills'
import { parseLocator } from '../../shared/runtimeLocator'
import { runtimes } from '../../main/runtime/runtimeManager'
import { windowFromEvent } from '../../main/windowRegistry'
import { syncWorkspaceSkills } from './skillsMirror'
import { listWorktreeCheckouts } from '../../main/worktreeContext'

async function syncOpenWorktrees(
  baseCwd: string,
  workspaceId: string | undefined,
  ownerWindowId: number | undefined,
): Promise<string[]> {
  if (!workspaceId) return []
  const { runtimeId, path } = parseLocator(baseCwd)
  if (!path) return []
  try {
    const runtime = runtimes.resolve(runtimeId)
    const worktrees = await listWorktreeCheckouts(baseCwd, runtime, {
      ownerWindowId,
      scopeId: workspaceId,
    })
    const results = await Promise.all(
      worktrees.map((worktree) => syncWorkspaceSkills(baseCwd, worktree)),
    )
    return results.flatMap((result) => result.warnings)
  } catch (err) {
    log.warn('[ipc.skills] worktree sync failed: %O', err)
    return []
  }
}

export function registerSkillHandlers(): void {
  ipcMain.handle(SKILLS_GET_INDEX, async () => {
    try {
      return await registry.getMergedIndex()
    } catch (err) {
      log.warn('[ipc.skills] getIndex failed: %O', err)
      return []
    }
  })

  ipcMain.handle(SKILLS_REFRESH, async () => {
    registry.refresh()
    return registry.getMergedIndex()
  })

  ipcMain.handle(SKILLS_GET_PREVIEW, async (_e, entry: SkillEntry) => {
    try {
      return await registry.getPreview(entry)
    } catch (err) {
      log.warn('[ipc.skills] getPreview failed: %O', err)
      return ''
    }
  })

  ipcMain.handle(SKILLS_INSTALL, async (event, entry: SkillEntry, targetId: SkillTargetId, cwd: string, workspaceId?: string) => {
    try {
      const res = await installer.install(entry, targetId, cwd)
      const mirrorWarnings = await syncOpenWorktrees(
        cwd,
        workspaceId,
        windowFromEvent(event)?.id,
      )
      return {
        ok: true as const,
        warnings: [...res.warnings, ...mirrorWarnings],
        installed: res.installed,
      }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(SKILLS_UNINSTALL, async (event, skillId: string, name: string, targetId: SkillTargetId, cwd: string, workspaceId?: string) => {
    try {
      await installer.uninstall(skillId, name, targetId, cwd)
      await syncOpenWorktrees(cwd, workspaceId, windowFromEvent(event)?.id)
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(SKILLS_SAVE, async (_e, entry: SkillEntry) => {
    try {
      await installer.saveSkill(entry)
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(SKILLS_UNSAVE, async (_e, skillId: string) => {
    try {
      await installer.unsaveSkill(skillId)
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(SKILLS_LIST_INSTALLED, async (_e, cwd: string) => {
    try {
      return await installer.listInstalled(cwd)
    } catch (err) {
      log.warn('[ipc.skills] listInstalled failed: %O', err)
      return []
    }
  })

  ipcMain.handle(SKILLS_LIST_SAVED, async () => savedSkills.listSaved())

  ipcMain.handle(SKILLS_LIST_SOURCES, async () => sources.listSources())

  ipcMain.handle(SKILLS_ADD_SOURCE, async (_e, repo: string, opts?: { ref?: string; path?: string }) => {
    try {
      const source = sources.addSource(repo, opts)
      registry.refresh()
      return { ok: true as const, source }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(SKILLS_REMOVE_SOURCE, async (_e, id: string) => {
    sources.removeSource(id)
    registry.refresh()
    return { ok: true as const }
  })

  ipcMain.handle(SKILLS_GET_TOKEN, async () => ({ hasToken: !!sources.getToken() }))

  ipcMain.handle(SKILLS_SET_TOKEN, async (_e, token: string | null) => {
    sources.setToken(token ?? undefined)
    registry.refresh()
    return { ok: true as const }
  })
}
