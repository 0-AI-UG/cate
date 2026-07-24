import { useCateAgentReady } from '../stores/providerReadinessStore'
import { ProvidersSettings } from './ProvidersSettings'

export function CanvasCateAgentSettings() {
  const gate = useCateAgentReady()

  return (
    <div className="flex flex-col gap-5">
      {gate === 'noProvider' && (
        <p className="rounded-md border border-agent/30 bg-agent/10 px-3 py-2.5 text-xs text-primary">
          Connect an AI provider to use the Cate Agent.
        </p>
      )}
      {gate === 'needsReauth' && (
        <p className="rounded-md border border-agent/30 bg-agent/10 px-3 py-2.5 text-xs text-primary">
          Reconnect your AI provider to keep using the Cate Agent.
        </p>
      )}
      <div>
        <h4 className="mb-1 text-xs font-semibold text-secondary">Providers</h4>
        <ProvidersSettings />
      </div>
    </div>
  )
}
