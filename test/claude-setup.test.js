import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeCodeCommand, claudeDesktopStatus, connectClaudeDesktop, serverEntry } from '../src/main/claude-setup.js'

const entry = serverEntry('/Applications/Orb.app/Contents/MacOS/Orb', '/Applications/Orb.app/Contents/Resources/app/src/mcp/server.js')

describe('connecting Claude Desktop', () => {
  it('keeps the user\'s other MCP servers and settings, and backs up the old file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orb-claude-'))
    const path = join(dir, 'claude_desktop_config.json')
    await writeFile(path, JSON.stringify({ mcpServers: { github: { command: 'gh' } }, theme: 'dark' }))
    assert.equal(await claudeDesktopStatus(entry, path), 'not-connected')
    await connectClaudeDesktop(entry, path)
    const saved = JSON.parse(await readFile(path, 'utf8'))
    assert.deepEqual(saved.mcpServers.github, { command: 'gh' })
    assert.equal(saved.theme, 'dark')
    assert.deepEqual(saved.mcpServers.orb, entry)
    assert.equal(saved.mcpServers.orb.env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(await claudeDesktopStatus(entry, path), 'connected')
    assert.equal((await readdir(dir)).filter((f) => f.includes('.before-orb-')).length, 1)
  })

  it('creates the file when Claude has never been configured', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'orb-claude-')), 'Claude', 'claude_desktop_config.json')
    await connectClaudeDesktop(entry, path)
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { mcpServers: { orb: entry } })
  })

  it('refuses to touch a file it cannot parse', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'orb-claude-')), 'claude_desktop_config.json')
    await writeFile(path, '{ "mcpServers": { oops ')
    await assert.rejects(connectClaudeDesktop(entry, path), /isn't valid JSON/)
    assert.equal(await readFile(path, 'utf8'), '{ "mcpServers": { oops ')
  })

  it('quotes the Claude Code command for paths with spaces', () => {
    const cmd = claudeCodeCommand('/Applications/My Apps/Orb', '/x/server.js', 'darwin')
    assert.equal(cmd, "claude mcp add --scope user orb --env ELECTRON_RUN_AS_NODE=1 -- '/Applications/My Apps/Orb' '/x/server.js'")
  })
})
