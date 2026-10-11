// The screen a window shows with no workspace selected (or none at all):
// the Cate logo, the Open picker (recent workspaces, this device and other
// machines, joining with a code), what is new in this version, and the
// shortcuts worth knowing.

import { useDeclaredActions, useResolvedShortcuts } from '../../kernel/interaction'
import { canRunAction } from '@client/host'
import { useActionsVersion } from '../../client/host/hooks'
import { displayString } from '@kernel/interaction/contract'
import { WorkspacePicker } from '../remote/WorkspacePicker'
import { CateLogo } from './CateLogo'
import { WhatsNew } from './WhatsNew'

export function WelcomePage(): JSX.Element {
  const shortcuts = useResolvedShortcuts()
  useActionsVersion()
  const welcome = useDeclaredActions().filter(({ id, spec }) => spec.welcome && canRunAction(id, { workspaceId: null }))

  return (
    <div data-welcome className="absolute inset-0 overflow-y-auto z-10">
      <div className="min-h-full flex items-center justify-center px-8 py-10">
        <div className="w-full max-w-4xl flex flex-col gap-8">
          <div className="flex flex-col items-center gap-2">
            <CateLogo size={240} className="h-28 w-auto text-primary" aria-label="Cate" />
            <p className="text-sm text-muted">Infinite canvas for coding</p>
          </div>

          <div className="grid items-start gap-4 md:grid-cols-[3fr_2fr]">
            <div data-onboarding="welcome-actions" className="flex flex-col rounded-xl border border-subtle bg-surface-1 p-3">
              <WorkspacePicker listClassName="max-h-[360px]" />
            </div>
            <div className="flex max-h-[440px] flex-col overflow-y-auto rounded-xl border border-subtle bg-surface-1 p-4">
              <WhatsNew />
            </div>
          </div>

          <div>
            <h2 className="text-[12px] font-medium text-secondary mb-2">Keyboard shortcuts</h2>
            <div className="grid grid-cols-2 gap-x-8 gap-y-1">
              {welcome.filter(({ id }) => shortcuts[id]?.key).map(({ id, spec }) => (
                <div key={id} className="flex items-center gap-2">
                  <span className="text-xs text-secondary font-mono w-10 text-right">{displayString(shortcuts[id])}</span>
                  <span className="text-xs text-muted">{spec.title}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
