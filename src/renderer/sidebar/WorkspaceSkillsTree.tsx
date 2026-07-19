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
import type { AgentId } from '../../shared/agents'
import { toSkillTargetGroups, type SkillTargetGroup } from './skillTargetGroups'
import log from '../lib/logger'

const api = () => window.electronAPI

const TARGET_LABEL: Record<string, string> = Object.fromEntries(
  SKILL_TARGETS.map((t) => [t.id, t.label]),
)

// Skill target → agent id for the logo lookup. cate-agent is Cate's built-in
// Agent panel — it has no bundled SVG and uses the panel's chat-bubble mark
// instead; pi-native's logo lives under `pi`.
const TARGET_LOGO_ID: Partial<Record<SkillTargetId, AgentId>> = {
  'claude-code': 'claude-code',
  'pi-native': 'pi',
  opencode: 'opencode',
  codex: 'codex',
}

const AgentIcon: React.FC<{ targetId: SkillTargetId }> = ({ targetId }) => {
  if (targetId === 'cate-agent') {
    return <ChatCircle size={11} className="flex-shrink-0 text-[rgb(var(--agent-rgb))]" style={{ opacity: 0.9 }} />
  }
  const logo = getAgentLogoById(TARGET_LOGO_ID[targetId])
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
  const [open, setOpen] = useState(true)
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
        onClick={() => setOpen((v) => !v)}
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
        groups.map((g) => (
          <React.Fragment key={g.targetId}>
            {/* Agent row */}
            <button
              type="button"
              onClick={openDialog}
              title={TARGET_LABEL[g.targetId] ?? g.targetId}
              className="flex items-center gap-1.5 h-7 pl-10 pr-2 text-[13px] text-muted hover:text-primary hover:bg-hover text-left min-w-0 focus:outline-none mx-1.5 my-0.5 rounded-lg"
            >
              <AgentIcon targetId={g.targetId} />
              <span className="truncate min-w-0 flex-1">{TARGET_LABEL[g.targetId] ?? g.targetId}</span>
            </button>
            {/* Skills nested under the agent */}
            {g.skills.map((s) => (
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
        ))}
    </>
  )
}
