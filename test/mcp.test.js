// Starts the real MCP server as a child process and talks to it the way Claude
// Desktop does (JSON-RPC over stdio), using the official SDK client.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const server = fileURLToPath(new URL('../src/mcp/server.js', import.meta.url))
const today = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})()

describe('MCP server over stdio', () => {
  let client
  let dir
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args })
    return { ...result, text: result.content.map((c) => c.text).join('\n') }
  }

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orb-mcp-'))
    await mkdir(join(dir, 'cfg'))
    await writeFile(join(dir, 'cfg', 'config.json'), JSON.stringify({ dataDir: join(dir, 'data'), dayStart: '00:00', dayEnd: '23:59' }))
    client = new Client({ name: 'orb-test', version: '1.0.0' })
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [server],
      env: { ...process.env, ORB_CONFIG: join(dir, 'cfg', 'config.json') },
      stderr: 'inherit',
    }))
  })

  after(async () => { await client?.close() })

  it('advertises the tools with input schemas', async () => {
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'add_task', 'complete_task', 'delete_task', 'find_free_time', 'list_calendar',
      'list_tasks', 'plan_task', 'refresh_calendars', 'update_task',
    ])
    const add = tools.find((t) => t.name === 'add_task')
    assert.deepEqual(add.inputSchema.required, ['title'])
    assert.equal(tools.find((t) => t.name === 'delete_task').annotations.destructiveHint, true)
  })

  it('the video\'s flow: "add book friday dinner to my to-do"', async () => {
    const added = await call('add_task', { title: 'book friday dinner', section: 'life' })
    assert.equal(added.isError, undefined)
    const file = await readFile(join(dir, 'data', 'todo.md'), 'utf8')
    assert.match(file, /## life\n- \[ \] book friday dinner\n/)
    const listed = await call('list_tasks')
    assert.match(listed.text, new RegExp(`Today is ${today}`))
    assert.equal(listed.structuredContent.tasks[0].title, 'book friday dinner')
  })

  it('finds free time and blocks it ("should I block out the time?")', async () => {
    const free = await call('find_free_time', { from: today, days: 2, minutes: 30 })
    const slot = free.structuredContent.slots.at(-1)
    const planned = await call('plan_task', { task: 'friday dinner', start: slot.start, minutes: 30 })
    assert.match(planned.text, /Planned "book friday dinner"/)
    const cal = await call('list_calendar', { from: slot.start.slice(0, 10) })
    assert.match(cal.text, /\[planned\] book friday dinner/)
  })

  it('rejects bad input with a readable error instead of corrupting the file', async () => {
    const file = () => readFile(join(dir, 'data', 'todo.md'), 'utf8')
    const before = await file()
    const bad = await call('add_task', { title: 'x', due: 'next friday' })
    assert.equal(bad.isError, true)
    assert.match(bad.text, /YYYY-MM-DD/)
    assert.equal(await file(), before, 'a rejected call writes nothing')

    await call('add_task', { title: 'book hotel', section: 'life' })
    const withHotel = await file()
    const ambiguous = await call('complete_task', { task: 'book' })
    assert.equal(ambiguous.isError, true)
    assert.match(ambiguous.text, /matches 2 tasks[^]*book friday dinner[^]*book hotel/)
    assert.equal(await file(), withHotel, 'an ambiguous call writes nothing')
  })

  it('never puts a calendar\'s secret link into the chat', async () => {
    const config = join(dir, 'cfg', 'config.json')
    const secret = 'https://outlook.office365.com/owa/calendar/SECRET-ID@school.edu/SECRET-KEY/calendar.ics'
    const current = JSON.parse(await readFile(config, 'utf8'))
    await writeFile(config, JSON.stringify({ ...current, feeds: [{ name: 'School', url: secret }] }))
    // The server reads its config at start, so ask a fresh server.
    const other = new Client({ name: 'orb-test-2', version: '1.0.0' })
    await other.connect(new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env, ORB_CONFIG: config }, stderr: 'ignore' }))
    try {
      const result = await other.callTool({ name: 'refresh_calendars', arguments: {} })
      const text = result.content.map((c) => c.text).join('\n')
      assert.match(text, /School/)
      assert.doesNotMatch(text, /SECRET|outlook\.office365/)
    } finally {
      await other.close()
      await writeFile(config, JSON.stringify(current))
    }
  })

  it('completes, and logs the change as Claude\'s', async () => {
    const done = await call('complete_task', { task: 'book hotel' })
    assert.match(done.text, /Completed "book hotel"/)
    const log = await readFile(join(dir, 'data', 'activity.log'), 'utf8')
    assert.match(log, /\tclaude\tcomplete "book hotel"/)
  })
})
