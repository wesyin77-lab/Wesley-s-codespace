/**
 * Entry point. Loads the real main process inside a try/catch so that a crash
 * at startup shows an error box and leaves a log, instead of the app silently
 * not appearing (an import error in main.js would otherwise kill it with no trace).
 */

import { app, dialog } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const logDir = join(homedir(), '.orb')
const logFile = join(logDir, 'error.log')

let started = false

function report(error) {
  const text = error?.stack || String(error)
  try {
    mkdirSync(logDir, { recursive: true })
    appendFileSync(logFile, `${new Date().toISOString()}\n${text}\n\n`)
  } catch {
    // Nowhere to write; the dialog below still tells the user.
  }
  // After startup, log and keep running: one failed calendar fetch must not close the app.
  if (started) return
  const show = () => {
    dialog.showErrorBox('Orb could not start', `${text.split('\n').slice(0, 6).join('\n')}\n\nFull details: ${logFile}`)
    app.exit(1)
  }
  if (app.isReady()) show()
  else app.whenReady().then(show)
}

process.on('uncaughtException', report)
process.on('unhandledRejection', report)

import('./main.js').then((main) => main.ready).then(() => { started = true }, report)
