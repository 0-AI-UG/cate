// Select the isolated engine before loading desktop main (device stores/UI).
// A failed helper reports to its log and exits; Electron's default uncaught
// exception dialog must never interrupt the person's desktop.
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

if (process.argv.includes('--cate-browser-engine')) {
  const fail = (error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    try {
      const dir = process.env.CATE_BROWSER_ENGINE_DATA!
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(path.join(dir, 'errors.log'), `${new Date().toISOString()} ${message}\n`)
    } catch { /* the parent may already have removed its temporary profile */ }
    app.exit(1)
  }
  process.on('uncaughtException', fail)
  process.on('unhandledRejection', fail)
  process.once('SIGTERM', () => app.exit(0))
  // Also covers a parent disappearing while the engine module is loading.
  process.once('disconnect', () => app.exit(0))
  void import('@services/browser/desktop').then(({ runBrowserEngine }) => runBrowserEngine()).catch(fail)
} else {
  void import('./index').catch(error => {
    // Startup can fail before desktop main installs its normal logger.
    try {
      const dir = app.getPath('userData')
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(path.join(dir, 'startup-errors.log'), `${new Date().toISOString()} ${error instanceof Error ? error.stack : String(error)}\n`)
    } catch { /* no writable profile */ }
    app.exit(1)
  })
}
