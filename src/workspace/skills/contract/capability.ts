import { defineCapability, method } from '@kernel/rpc/contract'
import type {
  InstalledSkill,
  SkillEntry,
  SkillInstallResult,
  SkillMirrorSyncResult,
  SkillSource,
  SkillTarget,
  SkillTargetId,
} from './types'

/** Skills of this workspace. Installs, uninstalls and worktree mirroring write
 *  into the workspace's agent dirs and `.cate/`, so they need trust. */
export const skillsCapability = defineCapability('skills', {
  methods: {
    targets: method<void, SkillTarget[]>(),
    /** Bundled skills, the curated index and the workspace sources' crawl. */
    index: method<{ refresh?: boolean }, SkillEntry[]>(),
    preview: method<{ entry: SkillEntry }, string>(),
    listInstalled: method<void, InstalledSkill[]>(),
    install: method<{ entry: SkillEntry; targetId: SkillTargetId }, SkillInstallResult>({ mutates: true }),
    uninstall: method<{ skillId: string; targetId: SkillTargetId }, { warnings: string[] }>({ mutates: true }),
    /** Replace Cate-managed copies of a bundled skill in every target that
     *  uses it, overwriting edits. */
    reinstallBundled: method<{ name: string }, { installedTargets: number; warnings: string[] }>({ mutates: true }),
    /** Mirror the root's installed skills into a worktree checkout. */
    syncCheckout: method<{ checkout: string }, SkillMirrorSyncResult>({ mutates: true }),
    listSources: method<void, SkillSource[]>(),
    addSource: method<{ repo: string; ref?: string; path?: string }, SkillSource>({ mutates: true }),
    removeSource: method<{ id: string }, void>({ mutates: true }),
  },
})

declare module '@kernel/rpc/contract' {
  interface CapabilityRegistry {
    skills: typeof skillsCapability
  }
}
