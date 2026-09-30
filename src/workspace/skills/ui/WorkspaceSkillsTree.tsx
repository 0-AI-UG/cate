// The skills a workspace's agents already have, folded into that workspace's
// expanded tree under one collapsible "Skills" node. Open it and each agent the
// workspace installs into is a row, with its skills nested one level beneath.
//
// Rendered only while the workspace is expanded, so the manifest read happens
// lazily per open workspace. Read-only: clicking a skill opens the skills view
// for this workspace; it never writes.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Puzzle as PuzzlePiece, ChevronRight as CaretRight } from 'lucide-react'
import { useRuntime } from '@kernel/rpc/ui'
import { createLogger } from '@kernel/log/contract'
import { skillAgentKey, skillsKey, toggleCollapsed, useIsCollapsed, useTreeCollapseStore } from '@workspace/files/ui'
import type { SkillTarget, SkillTargetId } from '../contract'
import { toSkillTargetGroups, type SkillTargetGroup } from './skillTargetGroups'

const log = createLogger('skills-tree')

export interface WorkspaceSkillsTreeProps {
  workspaceId: string
  /** The client setting `showSkillsInWorkspaceOverview`. */
  enabled: boolean
  /** While true (the skills view is open) the tree does not refetch; it
   *  refetches when it turns false, so installs there show here. */
  skillsViewOpen?: boolean
  /** Opens the skills view on this workspace. */
  onOpenSkills: () => void
  /** Logo URL of the agent behind a skill target, when the client has one. */
  targetLogo?: (targetId: SkillTargetId) => string | null | undefined
}

const AgentIcon: React.FC<{ logo: string | null | undefined }> = ({ logo }) => {
  if (logo) {
    return (
      <img
        src={logo}
        alt=""
        width={11}
        height={11}
        draggable={false}
        className="flex-shrink-0"
        style={{ width: 11, height: 11, objectFit: 'contain', display: 'block', opacity: 0.9 }}
      />
    )
  }
  return <PuzzlePiece size={11} className="flex-shrink-0" style={{ opacity: 0.6 }} />
}

export const WorkspaceSkillsTree: React.FC<WorkspaceSkillsTreeProps> = ({
  workspaceId,
  enabled,
  skillsViewOpen = false,
  onOpenSkills,
  targetLogo,
}) => {
  const runtime = useRuntime(workspaceId)
  const [groups, setGroups] = useState<SkillTargetGroup[]>([])
  const [targets, setTargets] = useState<SkillTarget[]>([])
  // Collapse state lives in the persisted tree collapse store: this component
  // unmounts whenever the workspace row folds.
  const open = !useIsCollapsed(skillsKey(workspaceId))
  const collapsed = useTreeCollapseStore((s) => s.collapsed)
  const toggleOpen = useCallback(() => toggleCollapsed(skillsKey(workspaceId)), [workspaceId])
  const toggleAgent = useCallback(
    (targetId: string) => toggleCollapsed(skillAgentKey(workspaceId, targetId)),
    [workspaceId],
  )

  const refresh = useCallback(async () => {
    if (!enabled || !runtime) {
      setGroups([])
      return
    }
    try {
      const [nextTargets, installed] = await Promise.all([runtime.skills.targets(), runtime.skills.listInstalled()])
      setTargets(nextTargets)
      setGroups(toSkillTargetGroups(installed, nextTargets))
    } catch (err) {
      log.warn('listInstalled failed: %s', err)
    }
  }, [enabled, runtime])

  useEffect(() => {
    if (skillsViewOpen) return
    void refresh()
  }, [skillsViewOpen, refresh])

  const labels = useMemo(() => new Map(targets.map((t) => [t.id, t.label])), [targets])

  if (!enabled || !runtime || groups.length === 0) return null

  return (
    <>
      {/* The "Skills" node: its icon aligns with the panel icons above it; the
          caret sits in the indent to its left. */}
      <button
        type="button"
        onClick={toggleOpen}
        title={open ? 'Collapse skills' : 'Expand skills'}
        className="flex items-center gap-1.5 h-7 pl-3 pr-2 text-[13px] text-muted hover:text-primary hover:bg-hover text-left min-w-0 focus:outline-none mx-1.5 my-0.5 rounded-lg"
      >
        <CaretRight
          size={10}
          className={`flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <PuzzlePiece size={11} className="flex-shrink-0" style={{ opacity: 0.6 }} />
        <span className="truncate min-w-0 flex-1">Skills</span>
      </button>

      {open &&
        groups.map((g) => {
          const agentOpen = !collapsed.has(skillAgentKey(workspaceId, g.targetId))
          return (
          <React.Fragment key={g.targetId}>
            <button
              type="button"
              onClick={() => toggleAgent(g.targetId)}
              title={agentOpen ? 'Collapse skills' : 'Expand skills'}
              className="flex items-center gap-1.5 h-7 pl-6 pr-2 text-[13px] text-muted hover:text-primary hover:bg-hover text-left min-w-0 focus:outline-none mx-1.5 my-0.5 rounded-lg"
            >
              <CaretRight
                size={10}
                className={`flex-shrink-0 transition-transform ${agentOpen ? 'rotate-90' : ''}`}
              />
              <AgentIcon logo={targetLogo?.(g.targetId)} />
              <span className="truncate min-w-0 flex-1">{labels.get(g.targetId) ?? g.targetId}</span>
            </button>
            {agentOpen &&
              g.skills.map((s) => (
              <button
                key={s.skillId}
                type="button"
                onClick={onOpenSkills}
                title={s.name}
                aria-label={`Skill ${s.name}`}
                className="flex items-center gap-1.5 h-7 pl-[3.25rem] pr-2 text-[13px] text-muted hover:text-primary hover:bg-hover text-left min-w-0 focus:outline-none mx-1.5 my-0.5 rounded-lg"
              >
                <PuzzlePiece size={11} className="flex-shrink-0" style={{ opacity: 0.6 }} />
                <span className="truncate min-w-0 flex-1">{s.name}</span>
              </button>
              ))}
          </React.Fragment>
          )
        })}
    </>
  )
}
