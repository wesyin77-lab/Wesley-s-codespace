/**
 * Settings shared by the app and the MCP server. Both processes read the same
 * file so Claude always edits the to-do list the panel shows.
 */

import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULTS = Object.freeze({
  dataDir: join(homedir(), 'Documents', 'Orb'),
  feeds: [],
  hotkey: 'CommandOrControl+Shift+Space',
  dimOpacity: 0.35,
  dayStart: '08:00',
  dayEnd: '22:00',
  icsPort: 47110,
  mode: 'widget',
  ball: null,
  widget: null,
})

export function configPath() {
  return process.env.ORB_CONFIG || join(homedir(), '.orb', 'config.json')
}

export function loadConfig() {
  let saved = {}
  try {
    saved = JSON.parse(readFileSync(configPath(), 'utf8'))
  } catch {
    // Missing or unreadable: run on defaults; the next save writes a fresh file.
  }
  const config = { ...DEFAULTS, ...saved }
  if (process.env.ORB_DIR) config.dataDir = process.env.ORB_DIR
  if (!Array.isArray(config.feeds)) config.feeds = []
  return config
}

export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch }
  if (process.env.ORB_DIR) delete next.dataDir
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, `${JSON.stringify(next, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
  return loadConfig()
}

export function paths(config = loadConfig()) {
  const dir = config.dataDir
  return {
    dir,
    todo: join(dir, 'todo.md'),
    log: join(dir, 'activity.log'),
    backups: join(dir, '.orb', 'backups'),
    cache: join(dir, '.orb', 'calendars'),
    ics: join(dir, 'orb.ics'),
    lock: join(dir, '.orb', 'todo.lock'),
  }
}
