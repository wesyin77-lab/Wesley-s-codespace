/**
 * Orb's MCP server: lets Claude (Desktop or Code) read and change your to-do list
 * and calendar with validated tools, instead of editing files by line number.
 *
 * Wiring follows danjdewhurst/todo-md-mcp (MIT); storage is Orb's own
 * line-preserving store, so your sections and notes are never rewritten.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { Service } from '../core/service.js'
import { TaskNotFoundError } from '../core/format.js'
import { addDays, localDateTime } from '../core/dates.js'
import { refreshFeeds } from '../core/feeds.js'

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
const DUE = z.string().regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/, 'Use YYYY-MM-DD or YYYY-MM-DDTHH:MM (local time)')
const DATETIME = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, 'Use YYYY-MM-DDTHH:MM (local time)')
const TASK_REF = z.string().min(1).describe('Words from the task title (e.g. "flight ticket") or an id from list_tasks')

export function createServer(service = new Service()) {
  const server = new McpServer({ name: 'orb', version: '0.1.0' }, {
    instructions: [
      'Orb is the user\'s to-do list (a Markdown file shown in a floating ball on their desktop) and calendar.',
      'When the user mentions something they need to do, offer to add it; when they say they finished something, complete it.',
      'Times are the user\'s local wall-clock time. Call list_tasks first if you need today\'s date.',
      'To help them actually do a task, use find_free_time and then plan_task to block time for it (ask before booking).',
    ].join(' '),
  })

  const ok = (text, data) => ({
    content: [{ type: 'text', text }],
    ...(data ? { structuredContent: data } : {}),
  })
  const fail = (error) => {
    let text = error.message
    if (error instanceof TaskNotFoundError && error.candidates.length) {
      text += `\nCandidates:\n${error.candidates.map(line).join('\n')}`
    }
    return { content: [{ type: 'text', text }], isError: true }
  }
  const guard = (fn) => async (args) => {
    try {
      return await fn(args)
    } catch (error) {
      return fail(error)
    }
  }
  const SOURCE = 'claude'

  server.registerTool('list_tasks', {
    title: 'List to-do tasks',
    description: 'List tasks from the user\'s to-do list, grouped by section, with due dates and planned time. Also returns today\'s date.',
    inputSchema: {
      status: z.enum(['open', 'done', 'all']).default('open'),
      section: z.string().optional().describe('Only this section (work, life, content, study, ...)'),
      due_by: DATE.optional().describe('Only tasks due on or before this date'),
    },
    annotations: { readOnlyHint: true },
  }, guard(async ({ status, section, due_by }) => {
    const snap = await service.snapshot()
    const tasks = snap.tasks.filter((t) => !t.cancelled
      && (status === 'all' || (status === 'done') === t.done)
      && (!section || t.section.toLowerCase() === section.toLowerCase())
      && (!due_by || (t.due && t.due.slice(0, 10) <= due_by)))
    const header = `Today is ${snap.today} (${weekday(snap.today)}). ${snap.counts.open} open, ${snap.counts.overdue} overdue, ${snap.counts.today} due today.`
    const bySection = new Map()
    for (const t of tasks) {
      if (!bySection.has(t.section)) bySection.set(t.section, [])
      bySection.get(t.section).push(line(t))
    }
    const body = [...bySection].map(([name, lines]) => `## ${name || '(no section)'}\n${lines.join('\n')}`).join('\n\n')
    return ok(`${header}\n\n${body || 'No matching tasks.'}`, {
      today: snap.today,
      sections: snap.sections,
      tasks: tasks.map(({ id, title, section, due, plan, done, doneDate, dueStatus }) => ({ id, title, section, due, plan, done, doneDate, dueStatus })),
    })
  }))

  server.registerTool('add_task', {
    title: 'Add a task',
    description: 'Add a task to the user\'s to-do list. Pick the section that fits (existing sections are listed by list_tasks); a new section name creates one.',
    inputSchema: {
      title: z.string().min(1).max(300),
      section: z.string().max(60).optional(),
      due: DUE.optional(),
      plan_start: DATETIME.optional().describe('Block time to do it: start (local time)'),
      plan_minutes: z.number().int().min(5).max(720).optional(),
    },
  }, guard(async ({ title, section, due, plan_start, plan_minutes }) => {
    const plan = plan_start ? { start: plan_start, minutes: plan_minutes ?? 30 } : undefined
    const result = await service.add(SOURCE, { title, section, due, plan })
    return ok(`Added "${result.title}"${result.section ? ` to ${result.section}` : ''}${due ? `, due ${due}` : ''}${plan ? `, planned ${plan.start} for ${plan.minutes} min` : ''}.`)
  }))

  server.registerTool('complete_task', {
    title: 'Complete a task',
    description: 'Mark a task done (or reopen it with done=false).',
    inputSchema: { task: TASK_REF, done: z.boolean().default(true) },
  }, guard(async ({ task, done }) => {
    const result = await service.complete(SOURCE, task, done)
    return ok(`${done ? 'Completed' : 'Reopened'} "${result.task.title}".`)
  }))

  server.registerTool('update_task', {
    title: 'Edit a task',
    description: 'Rename a task, move it to another section, or change its due date. Pass due=null to remove the due date.',
    inputSchema: {
      task: TASK_REF,
      title: z.string().min(1).max(300).optional(),
      section: z.string().max(60).optional(),
      due: DUE.nullable().optional(),
    },
  }, guard(async ({ task, title, section, due }) => {
    const patch = {}
    if (title !== undefined) patch.title = title
    if (section !== undefined) patch.section = section
    if (due !== undefined) patch.due = due
    if (Object.keys(patch).length === 0) throw new Error('Nothing to change.')
    const result = await service.update(SOURCE, task, patch)
    return ok(`Updated "${result.task.title}".`)
  }))

  server.registerTool('delete_task', {
    title: 'Delete a task',
    description: 'Delete a task entirely. Prefer complete_task for finished work; only delete when the user asks. A backup is kept.',
    inputSchema: { task: TASK_REF },
    annotations: { destructiveHint: true },
  }, guard(async ({ task }) => {
    const result = await service.remove(SOURCE, task)
    return ok(`Deleted "${result.task.title}". (Backups are kept in the Orb folder.)`)
  }))

  server.registerTool('list_calendar', {
    title: 'Show calendar',
    description: 'The user\'s calendar between two dates: events from their subscribed calendars, time blocks planned for tasks, and tasks due.',
    inputSchema: { from: DATE, to: DATE.optional().describe('Inclusive; defaults to `from`') },
    annotations: { readOnlyHint: true },
  }, guard(async ({ from, to }) => {
    const end = to ?? from
    if (end < from) throw new Error('`to` is before `from`.')
    if (end > addDays(from, 62)) throw new Error('Ask for at most two months at a time.')
    const { days, problems } = await service.calendar(from, end)
    const text = days.map(({ day, items }) => `## ${day} (${weekday(day)})\n${items.length ? items.map(agendaLine).join('\n') : '(nothing)'}`).join('\n\n')
    const warn = problems.length ? `\n\nSome calendars could not be read: ${problems.map((p) => p.error).join('; ')}` : ''
    return ok(text + warn)
  }))

  server.registerTool('find_free_time', {
    title: 'Find free time',
    description: `Free slots of at least \`minutes\` in the user's day (between their day start and end), avoiding calendar events and already-planned blocks.`,
    inputSchema: {
      from: DATE,
      days: z.number().int().min(1).max(14).default(1),
      minutes: z.number().int().min(5).max(720),
    },
    annotations: { readOnlyHint: true },
  }, guard(async ({ from, days, minutes }) => {
    const slots = await service.freeTime({ from, days, minutes })
    if (slots.length === 0) return ok('No free slot that long in that range.')
    return ok(slots.map((s) => `${localDateTime(s.start)} – ${localDateTime(s.end).slice(11)}`).join('\n'), {
      slots: slots.map((s) => ({ start: localDateTime(s.start), end: localDateTime(s.end) })),
    })
  }))

  server.registerTool('plan_task', {
    title: 'Block time for a task',
    description: 'Put a time block for a task on the user\'s calendar (shown in Orb and its calendar feed). Pass start=null to remove the block.',
    inputSchema: {
      task: TASK_REF,
      start: DATETIME.nullable(),
      minutes: z.number().int().min(5).max(720).default(30),
    },
  }, guard(async ({ task, start, minutes }) => {
    const result = await service.plan(SOURCE, task, start, minutes)
    return ok(start ? `Planned "${result.task.title}" at ${start} for ${minutes} min.` : `Removed the time block for "${result.task.title}".`)
  }))

  server.registerTool('refresh_calendars', {
    title: 'Refresh calendars',
    description: 'Re-download the user\'s subscribed calendars (Orb also does this every 15 minutes).',
    inputSchema: {},
  }, guard(async () => {
    const results = await refreshFeeds(service.config.feeds, service.paths)
    if (results.length === 0) return ok('No calendars are subscribed yet. The user can add one in Orb → Settings.')
    // Report calendars by name only: a feed link is a secret and must not end up in the chat.
    return ok(results.map((r, i) => `${r.ok ? '✓' : '✗'} ${service.config.feeds[i]?.name || `Calendar ${i + 1}`}${r.ok ? '' : `: ${r.error}`}`).join('\n'))
  }))

  return server
}

function weekday(day) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'long' })
}

function line(t) {
  const bits = [`- [${t.done ? 'x' : ' '}] ${t.title}`]
  if (t.due) bits.push(`due ${t.due}${t.dueStatus === 'overdue' ? ' (OVERDUE)' : t.dueStatus === 'today' ? ' (today)' : ''}`)
  if (t.plan) bits.push(`planned ${t.plan.start} for ${t.plan.minutes} min`)
  if (t.done && t.doneDate) bits.push(`done ${t.doneDate}`)
  return `${bits.join(' · ')}  [id ${t.id}]`
}

function agendaLine(item) {
  const time = item.allDay ? 'all day' : localDateTime(item.start).slice(11)
  const end = item.end && !item.allDay ? `–${localDateTime(item.end).slice(11)}` : ''
  if (item.kind === 'event') return `- ${time}${end} ${item.title}${item.calendar ? ` (${item.calendar})` : ''}${item.location ? ` @ ${item.location}` : ''}`
  if (item.kind === 'plan') return `- ${time}${end} [planned] ${item.title}`
  return `- ${item.allDay ? 'due' : `due ${time}`}: ${item.title}${item.task?.done ? ' (done)' : ''}`
}
