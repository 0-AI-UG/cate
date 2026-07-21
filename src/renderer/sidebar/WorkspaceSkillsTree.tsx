// =============================================================================
// WorkspaceSkillsTree — the skills a workspace's agents already have, folded into
// that workspace's expanded tree under a single collapsible "Skills" node. Open
// it and each agent the workspace installs into (Claude Code, Agent, …) is
// a row, with the skills installed for that agent nested one level beneath.
//
// Rendered only while the workspace is expanded, so the manifest read
// (`skillsListInstalled`) happens lazily per open workspace, never for every row
// in the list. Read-only: clicking an agent or skill row selects the workspace
// and opens the full SkillsDialog (which always acts on the selected workspace);
// it never writes.
// =============================================================================

import React, { useCallback, useEffect, useState } from 'react'
import { PuzzlePiece, CaretRight, ChatCircle } from '@phosphor-icons/react'
import { useAppStore } from '../stores/appStore'
import { useUIStore } from '../stores/uiStore'
import { getAgentLogoById } from '../lib/agent/agentLogos'
import { SKILL_TARGETS, type SkillTargetId } from '../../shared/skills'
import { agentForSkillTarget, type AgentId } from '../../shared/agents'
import { toSkillTargetGroups, type SkillTargetGroup } from './skillTargetGroups'
import { skillAgentKey, skillsKey, toggleCollapsed, useIsCollapsed, useTreeCollapseStore } from './treeCollapse'
import log from '../lib/logger'

const api = () => window.electronAPI

const TARGET_LABEL: Record<string, string> = Object.fromEntries(
  SKILL_TARGETS.map((t) => [t.id, t.label]),
)

// Skill target → agent id for the logo lookup, resolved through the canonical
// registry so a newly declared target picks up its agent's logo automatically.
// cate-agent is Cate's built-in Agent panel — it has no AgentDef and no bundled
// SVG, and uses the panel's chat-bubble mark instead.
const targetLogoId = (targetId: SkillTargetId): AgentId | null =>
  agentForSkillTarget(targetId)?.id ?? null

const AgentIcon: React.FC<{ targetId: SkillTargetId }> = ({ targetId }) => {
  if (targetId === 'cate-agent') {
    return <ChatCircle size={11} className="flex-shrink-0 text-[rgb(var(--agent-rgb))]" style={{ opacity: 0.9 }} />
  }
  const logo = getAgentLogoById(targetLogoId(targetId))
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

export const WorkspaceSkillsTree: React.FC<{ workspaceId: string; rootPath: string }> = ({
  workspaceId,
  rootPath,
}) => {
  const [groups, setGroups] = useState<SkillTargetGroup[]>([])
  // Collapse state lives in the persisted sidebar store, not local state: this
  // component unmounts whenever the workspace row folds, so useState would reset
  // every fold and every restart.
  const open = !useIsCollapsed(skillsKey(workspaceId))
  const collapsed = useTreeCollapseStore((s) => s.collapsed)
  const toggleOpen = useCallback(() => toggleCollapsed(skillsKey(workspaceId)), [workspaceId])
  const toggleAgent = useCallback(
    (targetId: string) => toggleCollapsed(skillAgentKey(workspaceId, targetId)),
    [workspaceId],
  )
  // Refetch when the Skills dialog closes — an install/uninstall there should
  // reflect here without a manual refresh.
  const showSkillsDialog = useUIStore((s) => s.showSkillsDialog)

  const refresh = useCallback(async () => {
    if (!rootPath) {
      setGroups([])
      return
    }
    try {
      setGroups(toSkillTargetGroups(await api().skillsListInstalled(rootPath)))
    } catch (err) {
      log.warn('[WorkspaceSkillsTree] listInstalled failed', err)
    }
  }, [rootPath])

  useEffect(() => {
    if (showSkillsDialog) return
    void refresh()
  }, [showSkillsDialog, refresh])

  const openDialog = useCallback(() => {
    useAppStore.getState().selectWorkspace(workspaceId)
    useUIStore.getState().setShowSkillsDialog(true)
  }, [workspaceId])

  if (!rootPath || groups.length === 0) return null

  return (
    <>
      {/* Collapsible "Skills" node — its puzzle icon aligns with the panel icons
          above it; the caret sits in the indent to its left. */}
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
            {/* Agent row — collapsible, its caret sits in the indent to the left
                of the agent icon (mirroring the "Skills" node above). */}
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
              <AgentIcon targetId={g.targetId} />
              <span className="truncate min-w-0 flex-1">{TARGET_LABEL[g.targetId] ?? g.targetId}</span>
            </button>
            {/* Skills nested under the agent */}
            {agentOpen &&
              g.skills.map((s) => (
              <button
                key={s.skillId}
                type="button"
                onClick={openDialog}
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
