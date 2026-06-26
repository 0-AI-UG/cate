// =============================================================================
// SkillsQuickBar — a compact, at-a-glance list of the skills installed in the
// current workspace, shown at the bottom of the Workspaces view (just above the
// version marker).
//
// The puzzle button in the activity bar opens the full SkillsDialog (browse /
// install / save). That dialog is the only place skills are visible, so once a
// workspace has skills there's no quick reminder of what its agents can already
// do. This bar surfaces them as small chips: hover for which agents have each,
// click any chip (or the +) to open the full dialog.
//
// Read-only and metadata-light by design — it reads the workspace manifest via
// the existing `skillsListInstalled` IPC and never installs or writes anything.
// =============================================================================

import React, { useCallback, useEffect, useState } from 'react'
import { PuzzlePiece, Plus } from '@phosphor-icons/react'
import { useUIStore } from '../stores/uiStore'
import { Tooltip } from '../ui/Tooltip'
import { SKILL_TARGETS } from '../../shared/skills'
import { toSkillChips, type SkillChip } from './skillChips'
import log from '../lib/logger'

const api = () => window.electronAPI

const TARGET_LABEL: Record<string, string> = Object.fromEntries(
  SKILL_TARGETS.map((t) => [t.id, t.label]),
)

export const SkillsQuickBar: React.FC<{ rootPath: string }> = ({ rootPath }) => {
  const [skills, setSkills] = useState<SkillChip[]>([])
  // Refetch when the Skills dialog closes — an install/uninstall there should
  // reflect here without a manual refresh.
  const showSkillsDialog = useUIStore((s) => s.showSkillsDialog)
  const openSkills = useUIStore((s) => s.setShowSkillsDialog)

  const refresh = useCallback(async () => {
    if (!rootPath) {
      setSkills([])
      return
    }
    try {
      setSkills(toSkillChips(await api().skillsListInstalled(rootPath)))
    } catch (err) {
      log.warn('[SkillsQuickBar] listInstalled failed', err)
    }
  }, [rootPath])

  useEffect(() => {
    if (showSkillsDialog) return
    void refresh()
  }, [showSkillsDialog, refresh])

  if (!rootPath) return null

  return (
    <div className="flex-shrink-0 px-2 pt-2 pb-1 border-t border-subtle">
      <div className="flex items-center justify-between px-1 pb-1.5 select-none">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">Skills</span>
        <Tooltip label="Browse &amp; install skills" placement="top">
          <button
            type="button"
            aria-label="Browse skills"
            onClick={() => openSkills(true)}
            className="flex items-center justify-center w-5 h-5 rounded text-muted hover:text-primary hover:bg-white/5 transition-colors"
          >
            <Plus size={12} />
          </button>
        </Tooltip>
      </div>

      {skills.length === 0 ? (
        <button
          type="button"
          onClick={() => openSkills(true)}
          className="w-full flex items-center gap-1.5 px-1.5 py-1 rounded text-[11px] text-muted hover:text-secondary hover:bg-white/5 transition-colors"
        >
          <PuzzlePiece size={12} className="shrink-0" />
          No skills yet — add some
        </button>
      ) : (
        <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
          {skills.map((s) => (
            <Tooltip
              key={s.skillId}
              label={`${s.name} · ${s.targets.map((t) => TARGET_LABEL[t] ?? t).join(', ')}`}
              placement="top"
            >
              <button
                type="button"
                aria-label={`Skill ${s.name}`}
                onClick={() => openSkills(true)}
                className="max-w-full truncate text-[11px] font-mono px-1.5 py-0.5 rounded bg-white/5 hover:bg-white/10 text-secondary hover:text-primary transition-colors"
              >
                {s.name}
              </button>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  )
}
