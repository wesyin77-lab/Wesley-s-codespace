import { describe, it, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Service } from '../src/core/service.js'
import { Store } from '../src/core/store.js'
import { paths as pathsFor, DEFAULTS } from '../src/core/config.js'

async function fresh(now = new Date(2026, 9, 25, 10, 0)) {
  const dir = await mkdtemp(join(tmpdir(), 'orb-test-'))
  const config = { ...DEFAULTS, dataDir: dir, feeds: [] }
  return { dir, service: new Service({ config, now: () => now }), config }
}

describe('store', () => {
  let ctx
  before(async () => { ctx = await fresh() })

  it('creates the starter file with the four sections', async () => {
    const snap = await ctx.service.snapshot()
    assert.deepEqual(snap.sections, ['work', 'life', 'content', 'study'])
  })

  it('logs who changed what, and backs up the previous version', async () => {
    await ctx.service.quickAdd('panel', 'book friday dinner #life')
    await ctx.service.complete('claude', 'friday dinner')
    const log = (await readFile(join(ctx.dir, 'activity.log'), 'utf8')).trim().split('\n')
    assert.match(log[0], /\tpanel\tadd "book friday dinner" to life due 2026-10-30$/)
    assert.match(log[1], /\tclaude\tcomplete "book friday dinner"$/)
    const backups = await readdir(join(ctx.dir, '.orb', 'backups'))
    assert.equal(backups.length, 2)
  })

  it('two writers (the app and the MCP server) never lose each other\'s changes', async () => {
    const { dir, config } = await fresh()
    const a = new Service({ config })
    const b = new Service({ config }) // a separate Store, like a second process
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      (i % 2 ? a : b).add(i % 2 ? 'panel' : 'claude', { title: `task ${i}`, section: 'work' })))
    const text = await readFile(join(dir, 'todo.md'), 'utf8')
    for (let i = 0; i < 20; i++) assert.ok(text.includes(`- [ ] task ${i}\n`), `task ${i}`)
  })

  it('reports hand edits to the watcher as external', async () => {
    const { dir, config } = await fresh()
    const store = new Store(pathsFor(config))
    await store.ensure()
    const seen = []
    const stop = store.watch((text, info) => seen.push(info.external))
    await new Promise((r) => setTimeout(r, 150))
    await writeFile(join(dir, 'todo.md'), '## work\n- [ ] edited by hand\n')
    await new Promise((r) => setTimeout(r, 400))
    stop()
    assert.deepEqual(seen, [false, true])
    assert.match(await readFile(join(dir, 'activity.log'), 'utf8'), /\tfile\tedited outside Orb/)
  })

  it('can start watching on first launch, before the folder exists', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'orb-first-'))
    const store = new Store(pathsFor({ ...DEFAULTS, dataDir: join(parent, 'Documents', 'Orb') }))
    const stop = store.watch(() => {})
    stop()
    await store.ensure()
    assert.match(await readFile(join(parent, 'Documents', 'Orb', 'todo.md'), 'utf8'), /## work/)
  })

  it('an ambiguous reference changes nothing', async () => {
    const { dir, service } = await fresh()
    await service.add('panel', { title: 'book flight' })
    await service.add('panel', { title: 'book hotel' })
    const before = await readFile(join(dir, 'todo.md'), 'utf8')
    await assert.rejects(service.complete('claude', 'book'), /matches 2 tasks/)
    assert.equal(await readFile(join(dir, 'todo.md'), 'utf8'), before)
  })

  it('writes orb.ics next to todo.md', async () => {
    const { dir, service } = await fresh()
    await service.add('panel', { title: 'essay', due: '2026-10-30' })
    await service.exportIcs()
    assert.match(await readFile(join(dir, 'orb.ics'), 'utf8'), /SUMMARY:Due: essay/)
  })

  it('counts overdue and due-today tasks for the ball', async () => {
    const { service } = await fresh()
    await service.add('panel', { title: 'late', due: '2026-10-21' })
    await service.add('panel', { title: 'today', due: '2026-10-25' })
    await service.add('panel', { title: 'later today', due: '2026-10-25T09:00' })
    await service.add('panel', { title: 'soon', due: '2026-10-26' })
    const { counts } = await service.snapshot()
    assert.deepEqual(counts, { open: 4, overdue: 2, today: 1 }, '09:00 already passed at 10:00')
  })
})
