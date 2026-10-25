/**
 * The to-do file format: plain Markdown task lists under `## section` headings,
 * with `key:value` tags for dates. See docs/FORMAT.md.
 *
 * Every function here is pure (text in, text out) and line-preserving: a line is
 * only rewritten when an operation targets it, so notes, blank lines and anything
 * else a person or an AI wrote by hand survive byte-for-byte.
 */

import { createHash } from 'node:crypto'

// Task-line grammar copied from obsidian-tasks (MIT), src/Task/TaskRegularExpressions.ts,
// so a line Obsidian treats as a task is a task here too.
const indentationRegex = /^([\s\t>]*)/
const listMarkerRegex = /([-*+]|[0-9]+[.)])/
const checkboxRegex = /\[(.)\]/u
const afterCheckboxRegex = / *(.*)/u
export const taskRegex = new RegExp(
  indentationRegex.source + listMarkerRegex.source + ' +' + checkboxRegex.source + afterCheckboxRegex.source,
  'u',
)
const blockLinkRegex = / \^[a-zA-Z0-9-]+$/u

const headingRegex = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
const PLAN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\/((?:\d+h)?(?:\d+m)?)$/
const TAG = /(^|\s)(due|plan|done):(\S+)/g

export const DEFAULT_SECTIONS = ['work', 'life', 'content', 'study']

export function starterFile() {
  return [
    '# To-do',
    '',
    ...DEFAULT_SECTIONS.flatMap((name) => [`## ${name}`, '']),
  ].join('\n')
}

/** `1h30m` → 90. Returns undefined for anything that is not a positive duration. */
export function parseDuration(text) {
  const match = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text)
  if (!match || (match[1] === undefined && match[2] === undefined)) return undefined
  const minutes = Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)
  return minutes > 0 ? minutes : undefined
}

/** 90 → `1h30m`, 45 → `45m`, 120 → `2h`. */
export function formatDuration(minutes) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h ? `${h}h` : ''}${m || !h ? `${m}m` : ''}`
}

export function isValidDate(text) {
  if (!DATE.test(text)) return false
  const [y, m, d] = text.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
}

export function isValidDue(text) {
  if (DATE.test(text)) return isValidDate(text)
  if (!DATETIME.test(text)) return false
  return isValidDate(text.slice(0, 10)) && isValidTime(text.slice(11))
}

function isValidTime(text) {
  const [h, m] = text.split(':').map(Number)
  return h < 24 && m < 60
}

/** Short stable fingerprint of a raw line, used to detect that a line changed under us. */
export function lineHash(raw) {
  return createHash('sha1').update(raw).digest('hex').slice(0, 8)
}

/**
 * Pull the recognised tags out of a task body. A tag whose value does not parse is
 * left in the title, so nothing a person typed silently disappears.
 */
export function splitBody(body) {
  let rest = body
  let blockLink = ''
  const link = blockLinkRegex.exec(rest)
  if (link) {
    blockLink = link[0]
    rest = rest.slice(0, link.index)
  }
  const fields = {}
  const title = rest.replace(TAG, (whole, lead, key, value) => {
    if (fields[key] !== undefined) return whole
    if (key === 'due' && isValidDue(value)) fields.due = value
    else if (key === 'done' && isValidDate(value)) fields.doneDate = value
    else if (key === 'plan') {
      const plan = PLAN.exec(value)
      const minutes = plan && parseDuration(plan[2])
      if (!plan || !minutes || !isValidDue(plan[1])) return whole
      fields.plan = { start: plan[1], minutes }
    } else return whole
    return lead
  }).replace(/\s+/g, ' ').trim()
  return { title, blockLink, ...fields }
}

/**
 * Parse the whole file. Returns every line (so callers can rebuild it) plus the
 * tasks and sections found in it.
 */
export function parse(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const tasks = []
  const sections = []
  let section = ''
  lines.forEach((raw, index) => {
    const heading = headingRegex.exec(raw)
    if (heading && heading[1].length >= 2) {
      section = heading[2]
      sections.push({ name: section, line: index })
      return
    }
    const match = taskRegex.exec(raw)
    if (!match) return
    const [, indent, marker, status, body] = match
    const fields = splitBody(body)
    tasks.push({
      id: `${index}:${lineHash(raw)}`,
      line: index,
      indent,
      marker,
      status,
      done: status === 'x' || status === 'X',
      cancelled: status === '-',
      section,
      ...fields,
    })
  })
  return { eol, lines, tasks, sections }
}

/** Rebuild one task line from its parts. Inverse of the parse above for the fields we own. */
export function formatTask(task) {
  const tags = []
  if (task.due) tags.push(`due:${task.due}`)
  if (task.plan) tags.push(`plan:${task.plan.start}/${formatDuration(task.plan.minutes)}`)
  if (task.done && task.doneDate) tags.push(`done:${task.doneDate}`)
  const body = [task.title, ...tags].filter(Boolean).join(' ')
  const status = task.status ?? (task.done ? 'x' : ' ')
  return `${task.indent ?? ''}${task.marker ?? '-'} [${status}] ${body}${task.blockLink ?? ''}`
}

function join(doc) {
  return doc.lines.join(doc.eol)
}

export class TaskNotFoundError extends Error {
  constructor(message, candidates = []) {
    super(message)
    this.name = 'TaskNotFoundError'
    this.candidates = candidates
  }
}

/**
 * Find a task by panel id (`line:hash`). If the file changed and the line moved,
 * fall back to the one line with the same content; otherwise refuse rather than
 * edit the wrong task.
 */
export function findById(doc, id) {
  const [lineText, hash] = String(id).split(':')
  const line = Number(lineText)
  const direct = doc.tasks.find((task) => task.line === line)
  if (direct && lineHash(doc.lines[line]) === hash) return direct
  const moved = doc.tasks.filter((task) => lineHash(doc.lines[task.line]) === hash)
  if (moved.length === 1) return moved[0]
  throw new TaskNotFoundError('That task changed since it was shown. Refresh and try again.')
}

/**
 * Find a task from free text, the way an AI refers to one ("the flight ticket").
 * Exact title beats prefix beats substring; ambiguity is an error listing the options.
 */
export function findByText(doc, query, { includeDone = false } = {}) {
  if (/^\d+:[0-9a-f]{8}$/.test(query)) return findById(doc, query)
  const q = query.trim().toLowerCase()
  const pool = doc.tasks.filter((task) => includeDone || !task.done)
  for (const test of [
    (t) => t.title.toLowerCase() === q,
    (t) => t.title.toLowerCase().startsWith(q),
    (t) => t.title.toLowerCase().includes(q),
  ]) {
    const hits = pool.filter(test)
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) {
      throw new TaskNotFoundError(`"${query}" matches ${hits.length} tasks; be more specific.`, hits)
    }
  }
  throw new TaskNotFoundError(`No ${includeDone ? '' : 'open '}task matches "${query}".`)
}

function sectionKey(name) {
  return name.trim().toLowerCase()
}

/** Line index after which a new task for `section` goes, adding the heading if needed. */
function insertionPoint(doc, section) {
  const target = doc.sections.find((s) => sectionKey(s.name) === sectionKey(section))
  if (!target) {
    // New section at the end, separated by one blank line.
    while (doc.lines.length > 0 && doc.lines[doc.lines.length - 1].trim() === '') doc.lines.pop()
    doc.lines.push('', `## ${section.trim()}`)
    return doc.lines.length
  }
  const next = doc.sections.find((s) => s.line > target.line)
  const end = next ? next.line : doc.lines.length
  let last = target.line
  for (let i = target.line + 1; i < end; i++) {
    if (doc.lines[i].trim() !== '') last = i
  }
  return last + 1
}

/** Insert a finished task line at the end of `section` (created if missing). */
function insertLine(doc, section, line) {
  let at
  if (section) at = insertionPoint(doc, section)
  else at = doc.lines[0]?.startsWith('# ') ? 1 : 0
  // Keep the file's single trailing newline after the new line, not before it.
  if (at >= doc.lines.length && doc.lines[doc.lines.length - 1] === '') at = doc.lines.length - 1
  doc.lines.splice(at, 0, line)
  if (doc.lines[doc.lines.length - 1] !== '') doc.lines.push('')
  return at
}

function cleanTitle(title) {
  const clean = String(title ?? '').replace(/\s+/g, ' ').trim()
  if (!clean) throw new Error('A task needs a title.')
  return clean
}

function validateDue(due) {
  if (due && !isValidDue(due)) throw new Error(`Bad due date "${due}". Use YYYY-MM-DD or YYYY-MM-DDTHH:MM.`)
}

function validatePlan(plan) {
  if (!plan || !DATETIME.test(plan.start) || !isValidDue(plan.start)) {
    throw new Error(`Bad plan start "${plan?.start}". Use YYYY-MM-DDTHH:MM.`)
  }
  if (!Number.isInteger(plan.minutes) || plan.minutes <= 0 || plan.minutes > 24 * 60) {
    throw new Error('Plan length must be between 1 and 1440 minutes.')
  }
}

/**
 * Add a task. With no section it goes to the first section (or the top of the
 * file when there are none).
 */
export function addTask(text, { title, section, due, plan }) {
  const clean = cleanTitle(title)
  validateDue(due)
  if (plan) validatePlan(plan)
  const doc = parse(text)
  const name = section?.trim() || doc.sections[0]?.name || ''
  const line = insertLine(doc, name, formatTask({ title: clean, due, plan }))
  return { text: join(doc), line, title: clean, section: name }
}

/**
 * Rewrite one task line with `patch` applied; `null` clears due/plan. Moving to
 * another section deletes the line and re-inserts it there.
 */
export function updateTask(text, task, patch, today) {
  const doc = parse(text)
  const current = doc.tasks.find((t) => t.line === task.line)
  if (!current) throw new TaskNotFoundError('Task not found.')
  const next = { ...current }
  if (patch.title !== undefined) next.title = cleanTitle(patch.title)
  if (patch.due !== undefined) {
    validateDue(patch.due)
    next.due = patch.due ?? undefined
  }
  if (patch.plan !== undefined) {
    if (patch.plan !== null) validatePlan(patch.plan)
    next.plan = patch.plan ?? undefined
  }
  if (patch.done !== undefined) {
    next.status = patch.done ? 'x' : ' '
    next.done = patch.done
    next.doneDate = patch.done ? today : undefined
  }
  const rebuilt = formatTask(next)
  if (patch.section !== undefined && sectionKey(patch.section) !== sectionKey(current.section)) {
    doc.lines.splice(current.line, 1)
    const moved = parse(join(doc))
    // A subtask moved out from under its parent becomes a top-level task.
    insertLine(moved, patch.section, formatTask({ ...next, indent: '' }))
    return join(moved)
  }
  doc.lines[current.line] = rebuilt
  return join(doc)
}

export function setDone(text, task, done, today) {
  return updateTask(text, task, { done }, today)
}

export function deleteTask(text, task) {
  const doc = parse(text)
  if (!doc.tasks.some((t) => t.line === task.line)) throw new TaskNotFoundError('Task not found.')
  doc.lines.splice(task.line, 1)
  return join(doc)
}


/**
 * Remove a `## section` heading. Only allowed when no open task is left in it, so a
 * slip of the mouse can't throw away work; finished tasks under it are kept and
 * simply join the section above.
 */
export function deleteSection(text, name) {
  const doc = parse(text)
  const index = doc.sections.findIndex((s) => sectionKey(s.name) === sectionKey(name))
  if (index === -1) throw new TaskNotFoundError(`There's no section called "${name}".`)
  const section = doc.sections[index]
  const open = doc.tasks.filter((t) => t.section === section.name && !t.done && !t.cancelled
    && t.line > section.line && (index + 1 >= doc.sections.length || t.line < doc.sections[index + 1].line))
  if (open.length) {
    throw new Error(`"${section.name}" still has ${open.length} task${open.length > 1 ? 's' : ''}. `
      + 'Move or finish them first (double-click a task and add #section to move it).')
  }
  // Take a blank line with it, so deleting doesn't leave a growing gap.
  const blankBefore = section.line > 0 && doc.lines[section.line - 1].trim() === ''
  const blankAfter = doc.lines[section.line + 1]?.trim() === ''
  doc.lines.splice(blankBefore ? section.line - 1 : section.line, blankBefore || blankAfter ? 2 : 1)
  return join(doc)
}
