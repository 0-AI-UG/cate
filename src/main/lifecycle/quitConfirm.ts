import { dialog, type BrowserWindow } from 'electron'
import { getSetting } from '../settingsFile'
import { getRunningTerminals } from '../ipc/shell'

// ---------------------------------------------------------------------------
// Quit-attempt state, shared by the two places a quit is gated:
//   • app 'before-quit'            — confirms with the user, then flushes the
//                                    session (shutdown.ts)
//   • the last main window 'close' — routes into the quit sequence rather than
//                                    tearing itself down (windowFactory.ts)
//
// It lives in its own module because shutdown.ts already imports windowFactory
// (for the `activate` re-open), so windowFactory can't import shutdown back.
//
// A quit attempt is NOT a one-way door: the user can cancel the confirmation and
// keep working. So every flag here is scoped to the attempt and cleared by
// resetQuitAttempt() the moment one is abandoned — never a permanent latch.
// (Permanent latches were a live hazard: a stale `true` makes a LATER quit skip
// the confirmation and the session flush entirely.)
// ---------------------------------------------------------------------------

/** The user has confirmed THIS attempt. Keeps the prompt to a single appearance
 *  as the quit crosses its gates. Deliberately NOT set when there was simply
 *  nothing to confirm — that isn't a decision to remember. */
let quitConfirmed = false

/** This attempt has cleared every gate: the session is saved and the app is on
 *  its way out. Windows may now be torn down for real. */
let quitCommitted = false

export function isQuitCommitted(): boolean {
  return quitCommitted
}

/** The quit has passed its gates — teardown may proceed. */
export function markQuitCommitted(): void {
  quitCommitted = true
}

/** A quit attempt ended with the app still running, so forget it: the next
 *  attempt must confirm and flush from scratch. */
export function resetQuitAttempt(): void {
  quitConfirmed = false
  quitCommitted = false
}

/** A confirmation dialog to show before quitting, or null to quit immediately.
 *  Two independent reasons gate quit: terminals still running a foreground
 *  process (data-loss warning, takes precedence so its specific message wins),
 *  and the user's "Warn before quit" preference (a plain confirmation). */
export function decideQuitPrompt(opts: {
  warnBeforeQuit: boolean
  running: Array<{ processName: string | null }>
}): { message: string; detail?: string } | null {
  const count = opts.running.length
  if (count > 0) {
    const name = count === 1 ? opts.running[0].processName?.trim() : undefined
    return {
      message:
        count > 1
          ? `${count} terminals are still running. Quit anyway?`
          : name
            ? `“${name}” is still running. Quit anyway?`
            : 'A terminal is still running. Quit anyway?',
      detail:
        count > 1
          ? 'The processes running in these terminals will be terminated.'
          : 'The process running in this terminal will be terminated.',
    }
  }
  if (opts.warnBeforeQuit) {
    return { message: 'Quit Cate?' }
  }
  return null
}

export type QuitGuardResult = 'proceed' | 'deferred'

/**
 * Gate a quit-causing action behind the running-terminal / "warn before quit"
 * confirmation.
 *
 * Returns 'proceed' when the caller may tear down right away — nothing to
 * confirm, or the user already confirmed this quit at an earlier gate.
 *
 * Returns 'deferred' when a dialog is now up. The caller MUST return without
 * touching any window: the quit has been prevented, `onConfirm` re-runs the
 * action if the user picks Quit, and Cancel simply leaves everything as it was.
 */
export function guardQuit(
  event: { preventDefault: () => void },
  parent: BrowserWindow | null | undefined,
  onConfirm: () => void,
): QuitGuardResult {
  if (quitConfirmed) return 'proceed'

  const prompt = decideQuitPrompt({
    warnBeforeQuit: getSetting('warnBeforeQuit'),
    running: getRunningTerminals(),
  })
  if (!prompt) return 'proceed'

  // Prevent FIRST — the dialog is async, so the action must be stopped now and
  // replayed from onConfirm rather than resumed.
  event.preventDefault()

  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    message: prompt.message,
    detail: prompt.detail,
    buttons: ['Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  }

  // Sheet it onto the window that triggered the quit when there is one; fall
  // back to an app-modal dialog rather than passing a dead/absent parent.
  void (parent && !parent.isDestroyed()
    ? dialog.showMessageBox(parent, options)
    : dialog.showMessageBox(options)
  ).then((result) => {
    if (result.response !== 0) {
      // Cancel — the app lives on, so this attempt must leave nothing behind.
      resetQuitAttempt()
      return
    }
    quitConfirmed = true
    onConfirm()
  })

  return 'deferred'
}
