/**
 * Reading and writing todo.md safely.
 *
 * - Every change goes through `mutate`, which holds a lock file so the panel and
 *   the MCP server (two processes) never interleave a read-modify-write.
 * - Writes are atomic (temp file + rename), so a crash never leaves half a file.
 * - The previous version is copied to a rolling backup before each write.
 * - Each change is appended to activity.log with who made it (panel, claude, ...).
 */

import { mkdir, readFile, writeFile, rename, appendFile, readdir, unlink, open, stat, copyFile } from 'node:fs/promises'
import { mkdirSync, watch } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { paths as configPaths } from './config.js'
import { parse, starterFile } from './format.js'

const KEEP_BACKUPS = 50
const LOCK_STALE_MS = 10_000
const LOCK_WAIT_MS = 5_000

export function contentHash(text) {
  return createHash('sha1').update(text).digest('hex')
}

export class Store {
  constructor(paths = configPaths()) {
    this.paths = paths
    this.queue = Promise.resolve()
    this.lastWritten = undefined
  }

  async ensure() {
    await mkdir(this.paths.backups, { recursive: true })
    try {
      await stat(this.paths.todo)
    } catch {
      await writeFile(this.paths.todo, starterFile(), { flag: 'wx' }).catch(() => {})
    }
  }

  async read() {
    await this.ensure()
    return readFile(this.paths.todo, 'utf8')
  }

  async load() {
    const text = await this.read()
    return { text, doc: parse(text) }
  }

  /**
   * Apply `change(text) → { text, ...result }` under the lock. Returns the result
   * object. `summary` describes the change for the activity log.
   */
  mutate(source, change) {
    const run = this.queue.then(() => this.#mutateLocked(source, change))
    this.queue = run.catch(() => {})
    return run
  }

  async #mutateLocked(source, change) {
    await this.ensure()
    const release = await this.#lock()
    try {
      const before = await readFile(this.paths.todo, 'utf8')
      const result = change(before)
      const after = typeof result === 'string' ? result : result.text
      if (after !== before) {
        await this.#backup()
        await this.#atomicWrite(after)
        const summary = typeof result === 'object' && result.summary ? result.summary : 'edit'
        await this.log(source, summary)
      }
      return typeof result === 'string' ? { text: after } : { ...result, text: after }
    } finally {
      await release()
    }
  }

  async log(source, summary) {
    const line = `${new Date().toISOString()}\t${source}\t${String(summary).replace(/[\t\r\n]+/g, ' ')}\n`
    await appendFile(this.paths.log, line)
  }

  async #loggedRecently() {
    try {
      const lines = (await readFile(this.paths.log, 'utf8')).trimEnd().split('\n')
      const last = Date.parse(lines[lines.length - 1].split('\t')[0])
      return Date.now() - last < 3_000
    } catch {
      return false
    }
  }

  async #atomicWrite(text) {
    const tmp = join(dirname(this.paths.todo), `.${basename(this.paths.todo)}.${process.pid}.tmp`)
    const handle = await open(tmp, 'w')
    try {
      await handle.writeFile(text)
      await handle.sync()
    } finally {
      await handle.close()
    }
    this.lastWritten = contentHash(text)
    await rename(tmp, this.paths.todo)
  }

  async #backup() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    await copyFile(this.paths.todo, join(this.paths.backups, `todo-${stamp}.md`)).catch(() => {})
    const files = (await readdir(this.paths.backups)).filter((f) => f.startsWith('todo-')).sort()
    await Promise.all(files.slice(0, Math.max(0, files.length - KEEP_BACKUPS))
      .map((f) => unlink(join(this.paths.backups, f)).catch(() => {})))
  }

  /** Cross-process lock: a file created exclusively, treated as stale after 10 s. */
  async #lock() {
    const deadline = Date.now() + LOCK_WAIT_MS
    for (;;) {
      try {
        const handle = await open(this.paths.lock, 'wx')
        await handle.writeFile(String(process.pid))
        await handle.close()
        return () => unlink(this.paths.lock).catch(() => {})
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        const age = await stat(this.paths.lock).then((s) => Date.now() - s.mtimeMs, () => 0)
        if (age > LOCK_STALE_MS) {
          await unlink(this.paths.lock).catch(() => {})
          continue
        }
        if (Date.now() > deadline) throw new Error('todo.md is busy (another program is writing it). Try again.')
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }
  }

  /**
   * Call `onChange(text, { external })` whenever todo.md changes on disk. Watches the
   * folder, not the file: an atomic rename replaces the file's inode, which a
   * file watch would lose on macOS and Linux.
   */
  watch(onChange) {
    let timer
    let lastSeen
    const check = async () => {
      let text
      try {
        text = await readFile(this.paths.todo, 'utf8')
      } catch {
        return
      }
      const hash = contentHash(text)
      if (hash === lastSeen) return
      const external = lastSeen !== undefined && hash !== this.lastWritten
      lastSeen = hash
      // The MCP server logs its own writes; only a change nobody logged is a hand edit.
      if (external && !(await this.#loggedRecently())) await this.log('file', 'edited outside Orb').catch(() => {})
      onChange(text, { external })
    }
    // On first launch the folder doesn't exist yet, and watching a missing folder throws.
    mkdirSync(this.paths.dir, { recursive: true })
    const watcher = watch(this.paths.dir, (event, file) => {
      if (file && file !== basename(this.paths.todo)) return
      clearTimeout(timer)
      timer = setTimeout(check, 60)
    })
    void check()
    // Some network and cloud-synced folders drop events; a slow poll is the backstop.
    const poll = setInterval(check, 5_000)
    return () => {
      watcher.close()
      clearInterval(poll)
      clearTimeout(timer)
    }
  }
}
