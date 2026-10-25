/**
 * The operations both front ends use: the panel (source "panel") and Claude
 * through MCP (source "claude"). Keeping one implementation means the AI and the
 * UI can never disagree about what "complete" or "plan" does.
 */

import { writeFile, rename } from 'node:fs/promises'
import { loadConfig, paths as configPaths } from './config.js'
import { Store } from './store.js'
import { addTask, updateTask, deleteTask, findById, findByText, parse } from './format.js'
import { quickAdd } from './quickadd.js'
import { agenda, buildIcs, findFreeTime } from './calendar.js'
import { loadFeedEvents } from './feeds.js'
import { dueStatus, localDate, parseLocal } from './dates.js'

export class Service {
  constructor({ config = loadConfig(), now = () => new Date() } = {}) {
    this.config = config
    this.paths = configPaths(config)
    this.store = new Store(this.paths)
    this.now = now
  }

  today() {
    return localDate(this.now())
  }

  /** Every task with its due status, plus the section names in file order. */
  async snapshot() {
    const { doc } = await this.store.load()
    return this.view(doc)
  }

  view(doc) {
    const now = this.now()
    const tasks = doc.tasks.map((task) => ({
      ...task,
      status: undefined,
      checkbox: task.status,
      dueStatus: task.done || task.cancelled ? undefined : dueStatus(task.due, now),
    }))
    const open = tasks.filter((t) => !t.done && !t.cancelled)
    return {
      today: localDate(now),
      sections: doc.sections.map((s) => s.name),
      tasks,
      counts: {
        open: open.length,
        overdue: open.filter((t) => t.dueStatus === 'overdue').length,
        today: open.filter((t) => t.dueStatus === 'today').length,
      },
    }
  }

  /** Free text from the quick-add box. */
  async quickAdd(source, input) {
    const { doc } = await this.store.load()
    const parsed = quickAdd(input, { now: this.now(), sections: doc.sections.map((s) => s.name) })
    if (!parsed.title) throw new Error('Type what needs doing.')
    return this.add(source, parsed)
  }

  previewQuickAdd(input, sections) {
    return quickAdd(input, { now: this.now(), sections })
  }

  async add(source, { title, section, due, plan }) {
    return this.store.mutate(source, (text) => {
      const result = addTask(text, { title, section, due, plan })
      return { ...result, summary: `add "${result.title}"${result.section ? ` to ${result.section}` : ''}${due ? ` due ${due}` : ''}` }
    })
  }

  /** `ref` is a panel id (`line:hash`) or, for the AI, words from the task title. */
  #find(doc, ref, includeDone) {
    return /^\d+:[0-9a-f]{8}$/.test(ref) ? findById(doc, ref) : findByText(doc, ref, { includeDone })
  }

  async update(source, ref, patch) {
    let found
    const result = await this.store.mutate(source, (text) => {
      const doc = parse(text)
      found = this.#find(doc, ref, true)
      const next = updateTask(text, found, patch, this.today())
      return { text: next, summary: `${describe(patch)} "${found.title}"` }
    })
    return { ...result, task: found }
  }

  complete(source, ref, done = true) {
    return this.update(source, ref, { done })
  }

  async remove(source, ref) {
    let found
    const result = await this.store.mutate(source, (text) => {
      const doc = parse(text)
      found = this.#find(doc, ref, true)
      return { text: deleteTask(text, found), summary: `delete "${found.title}"` }
    })
    return { ...result, task: found }
  }

  plan(source, ref, start, minutes) {
    return this.update(source, ref, { plan: start ? { start, minutes } : null })
  }

  /** Feed events plus tasks between two local dates (inclusive). */
  async calendar(fromDay, toDay) {
    const from = parseLocal(fromDay)
    const to = parseLocal(toDay)
    to.setDate(to.getDate() + 1)
    const [{ tasks }, feeds] = await Promise.all([
      this.snapshot(),
      loadFeedEvents(this.config.feeds, this.paths, { from, to }),
    ])
    const days = []
    for (const d = new Date(from); d < to; d.setDate(d.getDate() + 1)) {
      const day = localDate(d)
      days.push({ day, items: agenda(day, { tasks, events: feeds.events }) })
    }
    return { days, problems: feeds.problems }
  }

  async freeTime({ from, days = 1, minutes }) {
    const start = parseLocal(from)
    const end = new Date(start)
    end.setDate(end.getDate() + days)
    const [{ tasks }, feeds] = await Promise.all([
      this.snapshot(),
      loadFeedEvents(this.config.feeds, this.paths, { from: start, to: end }),
    ])
    return findFreeTime({
      from, days, minutes, tasks, events: feeds.events, now: this.now(),
      dayStart: this.config.dayStart, dayEnd: this.config.dayEnd,
    })
  }

  /** Write orb.ics next to todo.md; returns the text (also served over loopback). */
  async exportIcs() {
    const { tasks } = await this.snapshot()
    const text = buildIcs(tasks, { now: this.now() })
    await writeFile(`${this.paths.ics}.tmp`, text)
    await rename(`${this.paths.ics}.tmp`, this.paths.ics)
    return text
  }
}

function describe(patch) {
  if (patch.done === true) return 'complete'
  if (patch.done === false) return 'reopen'
  if (patch.plan === null) return 'unplan'
  if (patch.plan) return `plan ${patch.plan.start} for ${patch.plan.minutes}m`
  if (patch.section !== undefined) return `move to ${patch.section}`
  return 'edit'
}
