// "Custom model prices": rates that replace LiteLLM pricing for the
// workspace's past and future usage, saved to its settings.

import { useRef, useState } from 'react'
import { Plus, RotateCcw, X } from 'lucide-react'
import {
  USAGE_PRICE_FIELDS,
  applyUsagePriceChanges,
  isEmptyUsagePriceDraft,
  usagePriceCell,
  usagePriceTableChanges,
  type UsagePriceDraft,
  type UsagePriceField,
  type UsagePrices,
} from '@services/agents/contract'
import { Button, Modal, Tooltip, inputCls } from '../../../kernel/interaction'
import { setWorkspaceSetting, workspaceSettingsFor } from '../../../kernel/settings'

type SaveResult = { status: 'saving' } | { status: 'saved' } | { status: 'failed'; error: string }

/** Null while the workspace's prices cannot be read. */
const readPrices = (workspaceId: string): UsagePrices | null => workspaceSettingsFor(workspaceId)?.getAll().usagePriceOverrides ?? null

export function UsagePriceOverrides({ workspace, models: usedModels, onClose }: {
  workspace: { id: string; label: string }
  /** The models the workspace used in the shown window. */
  models: readonly string[]
  onClose: () => void
}) {
  const [prices, setPrices] = useState(() => readPrices(workspace.id))
  const [drafts, setDrafts] = useState<UsagePriceDraft[]>([])
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<SaveResult | null>(null)
  const focusRow = useRef<string | null>(null)
  const nextRow = useRef(0)

  const customModels = Object.keys(prices ?? {}).sort()
  const models = [...new Set([...customModels, ...usedModels])].sort()
  const rows: UsagePriceDraft[] = [
    ...customModels.map((model) => drafts.find((d) => d.id === `model:${model}`) ?? { id: `model:${model}`, model, isNew: false, values: {} }),
    ...drafts.filter((d) => d.isNew),
  ]
  const staged = drafts.filter((d) => !isEmptyUsagePriceDraft(d))
  const errors = prices === null ? new Map<string, string>() : usagePriceTableChanges(prices, staged).errors
  for (const draft of staged) {
    if (!draft.isNew) continue
    if (draft.model.trim() === '') errors.set(draft.id, 'Enter a model ID.')
    else if (customModels.includes(draft.model.trim()) || drafts.some((o) => o.id !== draft.id && o.model.trim() === draft.model.trim())) {
      errors.set(draft.id, 'This model already has a row. Edit its prices there.')
    }
  }
  const hasChanges = staged.length > 0

  const updateDraft = (draft: UsagePriceDraft) => {
    setDrafts((previous) => previous.some((d) => d.id === draft.id) ? previous.map((d) => d.id === draft.id ? draft : d) : [...previous, draft])
    setResult(null)
  }
  const editCell = (row: UsagePriceDraft, field: UsagePriceField, value: string) => {
    const values = { ...row.values, [field]: value }
    const original = usagePriceCell(prices, row.model, field)
    if (!row.isNew && original.placeholder !== 'Unavailable' && value === original.value) delete values[field]
    if (!row.isNew && Object.keys(values).length === 0) setDrafts((previous) => previous.filter((d) => d.id !== row.id))
    else updateDraft({ ...row, values })
  }
  const save = async () => {
    if (pending || !hasChanges) return
    setPending(true)
    setResult({ status: 'saving' })
    const plan = prices === null ? null : usagePriceTableChanges(prices, staged)
    let next: SaveResult
    if (prices === null || plan === null) next = { status: 'failed', error: 'Prices not loaded' }
    else if (plan.errors.size > 0) next = { status: 'failed', error: [...plan.errors.values()][0] }
    else {
      try {
        if (plan.changes.length > 0) await setWorkspaceSetting(workspace.id, 'usagePriceOverrides', applyUsagePriceChanges(prices, plan.changes))
        next = { status: 'saved' }
      } catch {
        next = { status: 'failed', error: 'Could not save. Try again.' }
      }
    }
    setResult(next)
    setPrices(readPrices(workspace.id))
    setPending(false)
    if (next.status !== 'failed') setDrafts([])
  }

  return (
    <Modal title="Custom model prices" onClose={() => { if (!pending) onClose() }} width={768} bodyClassName="flex flex-col gap-4 p-5">
      <div className="-mt-1 flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
        <span>Prices apply to all past and future usage in {workspace.label}.</span>
        <span>USD / million tokens</span>
      </div>
      <div className="min-w-0 overflow-x-auto rounded-lg border border-subtle">
        <table className="w-full min-w-[640px] table-fixed text-[13px]" aria-label="Custom model prices">
          <colgroup>
            <col className="w-[34%]" />
            {USAGE_PRICE_FIELDS.map((field) => <col key={field.key} />)}
            <col className="w-10" />
          </colgroup>
          <thead>
            <tr className="border-b border-subtle text-left text-[12px] text-muted">
              <th className="py-2 pl-3 font-normal">Model ID</th>
              {USAGE_PRICE_FIELDS.map((field) => <th key={field.key} className="px-1 py-2 font-normal">{field.label}</th>)}
              <th className="px-1 py-1">
                <Tooltip label="Add model price">
                  <button
                    type="button"
                    aria-label="Add model price"
                    disabled={pending}
                    onClick={() => {
                      const id = `new:${nextRow.current++}`
                      focusRow.current = id
                      updateDraft({ id, model: '', isNew: true, values: {} })
                    }}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
                  >
                    <Plus size={14} />
                  </button>
                </Tooltip>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-8 text-center text-muted">
                  {prices === null ? 'This workspace’s prices are unavailable.' : 'No custom prices. Add a row to override automatic pricing.'}
                </td>
              </tr>
            ) : rows.map((row) => (
              <tr key={row.id} className="border-b border-subtle last:border-b-0">
                <td className="py-1.5 pl-3 align-top">
                  {row.isNew ? (
                    <input
                      ref={(node) => {
                        if (node && focusRow.current === row.id) {
                          node.focus()
                          focusRow.current = null
                        }
                      }}
                      value={row.model}
                      aria-label="New model ID"
                      list="usage-price-models"
                      placeholder="Model ID"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={pending}
                      onChange={(event) => updateDraft({ ...row, model: event.target.value })}
                      className={`${inputCls} h-7 py-0`}
                    />
                  ) : (
                    <span className={`block break-all pt-1 ${row.removed ? 'text-muted line-through' : 'text-primary'}`}>{row.model}</span>
                  )}
                  {errors.has(row.id) && (row.model.trim() !== '' || Object.values(row.values).some((v) => v !== '')) && (
                    <p role="alert" className="mt-1 text-[12px] text-danger">{errors.get(row.id)}</p>
                  )}
                </td>
                {row.removed ? (
                  <td colSpan={4} className="px-1 py-1.5 text-muted">Automatic pricing after saving</td>
                ) : USAGE_PRICE_FIELDS.map((field) => {
                  const cell = usagePriceCell(prices, row.model, field.key)
                  return (
                    <td key={field.key} className="px-1 py-1.5 align-top">
                      <input
                        inputMode="decimal"
                        aria-label={`${field.label} price for ${row.model || 'new model'}`}
                        value={row.values[field.key] ?? (row.isNew ? '' : cell.value)}
                        placeholder={row.isNew ? (field.optional ? 'Input rate' : '0.00') : cell.placeholder}
                        autoComplete="off"
                        disabled={pending}
                        onChange={(event) => editCell(row, field.key, event.target.value)}
                        className={`${inputCls} h-7 py-0 tabular-nums`}
                      />
                    </td>
                  )
                })}
                <td className="px-1 py-1.5 align-top">
                  <Tooltip label={row.removed ? 'Undo reset' : row.isNew ? 'Remove row' : 'Reset to automatic'}>
                    <button
                      type="button"
                      disabled={pending}
                      aria-label={row.removed ? `Undo reset for ${row.model}` : row.isNew ? 'Remove new model' : `Reset price for ${row.model} to automatic`}
                      onClick={() => {
                        if (row.isNew) setDrafts((previous) => previous.filter((d) => d.id !== row.id))
                        else if (row.removed) {
                          if (Object.keys(row.values).length === 0) setDrafts((previous) => previous.filter((d) => d.id !== row.id))
                          else updateDraft({ ...row, removed: false })
                        } else updateDraft({ ...row, removed: true })
                      }}
                      className="flex h-7 w-6 items-center justify-center rounded-md text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
                    >
                      {row.isNew ? <X size={14} /> : <RotateCcw size={14} />}
                    </button>
                  </Tooltip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <datalist id="usage-price-models">
        {models.filter((m) => !customModels.includes(m)).map((m) => <option key={m} value={m} />)}
      </datalist>
      <p className="text-[12px] text-muted">Blank cache rates use the input price. Enter 0 for free tokens.</p>
      <div className="flex items-center justify-between gap-2">
        <span role="status" className={`text-[12px] ${result?.status === 'failed' ? 'text-danger' : 'text-muted'}`}>
          {result?.status === 'failed' ? `Not saved · ${result.error}` : result?.status === 'saved' ? 'Saved' : result?.status === 'saving' ? 'Saving…' : ''}
        </span>
        <div className="flex flex-wrap justify-end gap-2">
          {hasChanges && <Button variant="ghost" disabled={pending} onClick={() => { setDrafts([]); setResult(null) }}>Discard changes</Button>}
          <Button variant="primary" disabled={pending || !hasChanges || errors.size > 0} onClick={() => void save()}>
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
