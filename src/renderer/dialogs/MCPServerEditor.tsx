// =============================================================================
// MCPServerEditor — Modal for adding or editing a `.mcp.json` server entry.
// Covers name / command / args / env plus an inline validate probe that
// surfaces the server's advertised capabilities before the entry is saved.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { X, Plus, Trash, CheckCircle, Warning, CircleNotch } from '@phosphor-icons/react'
import type { MCPServerDefinition, MCPTestResult } from '../../shared/types'
import { useAIConfigStore } from '../stores/aiConfigStore'

const INPUT_CLS =
  'bg-surface-3 text-primary text-[11px] px-2 py-1 rounded border border-subtle outline-none focus:border-blue-500/50 w-full font-mono'

interface Props {
  rootPath: string
  /** When set, prefill with this server's config and save via updateMcpServer. */
  editingServer?: MCPServerDefinition
  onClose: () => void
}

interface EnvRow { key: string; value: string }

function envToRows(env: Record<string, string>): EnvRow[] {
  return Object.entries(env).map(([key, value]) => ({ key, value }))
}

function rowsToEnv(rows: EnvRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const row of rows) {
    const k = row.key.trim()
    if (!k) continue
    out[k] = row.value
  }
  return out
}

export function MCPServerEditor({ rootPath, editingServer, onClose }: Props) {
  const addMcpServer = useAIConfigStore((s) => s.addMcpServer)
  const updateMcpServer = useAIConfigStore((s) => s.updateMcpServer)
  const existingServers = useAIConfigStore((s) => s.mcpServers)

  const isEdit = !!editingServer
  const [name, setName] = useState(editingServer?.name ?? '')
  const [command, setCommand] = useState(editingServer?.command ?? '')
  const [argsText, setArgsText] = useState((editingServer?.args ?? []).join(' '))
  const [envRows, setEnvRows] = useState<EnvRow[]>(envToRows(editingServer?.env ?? {}))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<MCPTestResult | null>(null)

  const nameTrimmed = name.trim()
  const commandTrimmed = command.trim()

  // args split is whitespace-aware but keeps quoted segments as a single arg.
  const parsedArgs = useMemo(() => {
    const matches = argsText.match(/("[^"]*"|'[^']*'|\S+)/g) ?? []
    return matches.map((m) => m.replace(/^["']|["']$/g, ''))
  }, [argsText])

  const validationError = useMemo(() => {
    if (!nameTrimmed) return 'Name is required'
    if (!commandTrimmed) return 'Command is required'
    if (!isEdit && existingServers[nameTrimmed]) return `"${nameTrimmed}" already exists`
    if (isEdit && nameTrimmed !== editingServer!.name && existingServers[nameTrimmed]) {
      return `"${nameTrimmed}" already exists`
    }
    return null
  }, [nameTrimmed, commandTrimmed, isEdit, editingServer, existingServers])

  const buildDefinition = useCallback((): MCPServerDefinition => ({
    name: nameTrimmed,
    command: commandTrimmed,
    args: parsedArgs,
    env: rowsToEnv(envRows),
  }), [nameTrimmed, commandTrimmed, parsedArgs, envRows])

  const handleSave = useCallback(async () => {
    if (validationError) { setError(validationError); return }
    setSaving(true); setError(null)
    try {
      const def = buildDefinition()
      if (isEdit) await updateMcpServer(editingServer!.name, def, rootPath)
      else await addMcpServer(def, rootPath)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [validationError, buildDefinition, isEdit, updateMcpServer, addMcpServer, editingServer, rootPath, onClose])

  const handleProbe = useCallback(async () => {
    if (!commandTrimmed) { setError('Command is required to validate'); return }
    setProbing(true); setProbeResult(null); setError(null)
    try {
      const def = buildDefinition()
      const result = await window.electronAPI.mcpTest(def.command, def.args, def.env)
      setProbeResult(result)
    } catch (err) {
      setProbeResult({ success: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setProbing(false)
    }
  }, [commandTrimmed, buildDefinition])

  // Env row operations
  const addEnvRow = () => setEnvRows((rs) => [...rs, { key: '', value: '' }])
  const updateEnvRow = (i: number, patch: Partial<EnvRow>) =>
    setEnvRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)))
  const removeEnvRow = (i: number) => setEnvRows((rs) => rs.filter((_, idx) => idx !== i))

  // Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    document.addEventListener('keydown', handler, { capture: true })
    return () => document.removeEventListener('keydown', handler, { capture: true })
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-h-[640px] rounded-xl overflow-hidden flex flex-col bg-surface-4 border border-subtle shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-subtle">
          <div className="text-primary text-sm font-medium">
            {isEdit ? `Edit MCP Server — ${editingServer!.name}` : 'Add MCP Server'}
          </div>
          <button onClick={onClose} className="text-muted hover:text-primary p-1 rounded hover:bg-hover" title="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {/* Name + Command */}
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-muted">Name</span>
              <input className={INPUT_CLS} value={name} onChange={(e) => setName(e.target.value)} placeholder="filesystem" autoFocus />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] uppercase tracking-wider text-muted">Command</span>
              <input className={INPUT_CLS} value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
            </label>
          </div>

          {/* Args */}
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wider text-muted">Args (space-separated, quote for spaces)</span>
            <input className={INPUT_CLS} value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem /path" />
            {parsedArgs.length > 0 && (
              <span className="text-[10px] text-muted">
                → {parsedArgs.map((a, i) => <code key={i} className="mr-1 px-1 rounded bg-surface-3">{a}</code>)}
              </span>
            )}
          </label>

          {/* Env */}
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-muted">Environment</span>
              <button onClick={addEnvRow} className="flex items-center gap-1 text-[10px] text-muted hover:text-primary">
                <Plus size={10} /> Add
              </button>
            </div>
            {envRows.length === 0 ? (
              <div className="text-[11px] text-muted italic">No environment variables</div>
            ) : (
              <div className="space-y-1">
                {envRows.map((row, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <input className={INPUT_CLS} style={{ flex: 1 }} value={row.key} onChange={(e) => updateEnvRow(i, { key: e.target.value })} placeholder="KEY" />
                    <input className={INPUT_CLS} style={{ flex: 2 }} value={row.value} onChange={(e) => updateEnvRow(i, { value: e.target.value })} placeholder="value" />
                    <button onClick={() => removeEnvRow(i)} className="text-muted hover:text-red-400 p-1"><Trash size={11} /></button>
                  </div>
                ))}
              </div>
            )}
            <span className="text-[10px] text-muted">
              LD_*, DYLD_*, NODE_OPTIONS, PYTHONSTARTUP, PYTHONPATH are stripped on spawn.
            </span>
          </div>

          {/* Validate */}
          <div className="pt-2 border-t border-subtle">
            <div className="flex items-center gap-2">
              <button
                onClick={handleProbe}
                disabled={probing || !commandTrimmed}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-surface-6 hover:bg-hover text-primary disabled:opacity-40"
              >
                {probing ? <CircleNotch size={12} className="animate-spin" /> : null}
                Validate
              </button>
              <span className="text-[10px] text-muted">Spawns the server, sends `initialize`, then stops.</span>
            </div>
            {probeResult && <ProbeResultView result={probeResult} />}
          </div>
        </div>

        {error && (
          <div className="px-4 py-2 text-xs text-red-400 bg-red-600/10 border-t border-subtle">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-subtle">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded text-muted hover:text-primary hover:bg-hover">Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving || !!validationError}
            className="text-xs px-3 py-1.5 rounded bg-blue-600/80 text-white hover:bg-blue-600 disabled:opacity-40"
          >
            {isEdit ? 'Save' : 'Add Server'}
          </button>
        </div>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Probe result preview
// -----------------------------------------------------------------------------

function ProbeResultView({ result }: { result: MCPTestResult }) {
  if (!result.success) {
    return (
      <div className="mt-2 flex items-start gap-2 text-[11px] text-red-400 bg-red-600/10 rounded px-2 py-1.5">
        <Warning size={12} className="mt-0.5 shrink-0" />
        <span className="font-mono break-all">{result.error ?? 'Probe failed'}</span>
      </div>
    )
  }

  const caps = result.capabilities ?? {}
  const advertised: string[] = []
  if (caps.tools) advertised.push('tools')
  if (caps.resources) advertised.push('resources')
  if (caps.prompts) advertised.push('prompts')
  if (caps.logging) advertised.push('logging')

  return (
    <div className="mt-2 flex items-start gap-2 text-[11px] text-emerald-400 bg-emerald-600/10 rounded px-2 py-1.5">
      <CheckCircle size={12} className="mt-0.5 shrink-0" />
      <div className="flex-1 space-y-0.5 text-secondary">
        <div>
          <span className="text-emerald-400">OK</span>
          {result.serverInfo?.name && <> — <span className="font-mono">{result.serverInfo.name}</span></>}
          {result.serverInfo?.version && <span className="text-muted"> v{result.serverInfo.version}</span>}
          {result.protocolVersion && <span className="text-muted"> · protocol {result.protocolVersion}</span>}
        </div>
        <div className="text-muted">
          Capabilities: {advertised.length > 0 ? advertised.join(', ') : <em className="italic">none advertised</em>}
        </div>
      </div>
    </div>
  )
}
