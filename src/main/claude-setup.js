/**
 * One-click "Connect to Claude": registers Orb's MCP server with Claude Desktop
 * and produces the equivalent command for Claude Code.
 *
 * The server runs on the Orb binary itself (ELECTRON_RUN_AS_NODE=1), so nobody has
 * to install Node.js. Claude Desktop's config is merged, never replaced, and the
 * previous file is backed up first.
 */

import { readFile, writeFile, mkdir, copyFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export function claudeDesktopConfigPath(platform = process.platform, env = process.env) {
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  if (platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Claude', 'claude_desktop_config.json')
}

export function serverEntry(execPath, serverScript) {
  return { command: execPath, args: [serverScript], env: { ELECTRON_RUN_AS_NODE: '1' } }
}

/** Shell command for Claude Code (`claude mcp add`), quoted for the current OS. */
export function claudeCodeCommand(execPath, serverScript, platform = process.platform) {
  const q = (s) => (platform === 'win32' ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`)
  return `claude mcp add --scope user orb --env ELECTRON_RUN_AS_NODE=1 -- ${q(execPath)} ${q(serverScript)}`
}

async function readConfig(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { config: {}, existed: false }
    throw error
  }
  try {
    const config = text.trim() ? JSON.parse(text) : {}
    if (typeof config !== 'object' || config === null || Array.isArray(config)) throw new Error('not an object')
    return { config, existed: true }
  } catch {
    throw new Error(`Claude's settings file isn't valid JSON, so Orb won't touch it: ${path}`)
  }
}

export async function connectClaudeDesktop(entry, path = claudeDesktopConfigPath()) {
  const { config, existed } = await readConfig(path)
  await mkdir(dirname(path), { recursive: true })
  if (existed) await copyFile(path, `${path}.before-orb-${Date.now()}.bak`)
  const next = { ...config, mcpServers: { ...(config.mcpServers ?? {}), orb: entry } }
  await writeFile(`${path}.tmp`, `${JSON.stringify(next, null, 2)}\n`)
  await rename(`${path}.tmp`, path)
  return { path }
}

export async function claudeDesktopStatus(entry, path = claudeDesktopConfigPath()) {
  try {
    const { config } = await readConfig(path)
    const current = config.mcpServers?.orb
    if (!current) return 'not-connected'
    return JSON.stringify(current) === JSON.stringify(entry) ? 'connected' : 'outdated'
  } catch {
    return 'unreadable'
  }
}
