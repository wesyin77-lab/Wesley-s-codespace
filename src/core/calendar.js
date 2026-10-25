/**
 * Calendars: read other people's iCalendar feeds (Google, iCloud, Canvas...),
 * publish Orb's own feed, merge everything into a day agenda, and find free time.
 *
 * Recurrence and time zones go through ical.js (Mozilla's parser, used by
 * Thunderbird) rather than hand-written code: RRULE/EXDATE/RECURRENCE-ID and
 * VTIMEZONE handling are where home-made calendar code breaks.
 */

import ICAL from 'ical.js'
import { createHash } from 'node:crypto'
import { addMinutes, localDate, parseLocal } from './dates.js'

const MAX_OCCURRENCES = 50_000

/**
 * Events from one .ics text that overlap [from, to). Each event:
 * { id, title, start: Date, end: Date, allDay, location, calendar, color, busy }.
 */
export function parseIcs(text, { from, to, calendar = '', color } = {}) {
  // Outlook/Exchange feeds start with a UTF-8 byte-order mark, which ical.js can't parse.
  const root = new ICAL.Component(ICAL.parse(String(text).replace(/^\uFEFF/, '')))
  for (const vtz of root.getAllSubcomponents('vtimezone')) {
    const tzid = vtz.getFirstPropertyValue('tzid')
    if (tzid && !ICAL.TimezoneService.has(tzid)) ICAL.TimezoneService.register(vtz)
  }
  const vevents = root.getAllSubcomponents('vevent')
  const exceptions = new Map()
  for (const vevent of vevents) {
    if (!vevent.hasProperty('recurrence-id')) continue
    const uid = vevent.getFirstPropertyValue('uid')
    if (!exceptions.has(uid)) exceptions.set(uid, [])
    exceptions.get(uid).push(vevent)
  }

  const out = []
  const push = (event, start, end, item) => {
    if (end <= from || start >= to) return
    if (String(item.component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED') return
    out.push({
      id: `${event.uid}@${start.toISOString()}`,
      title: item.summary || '(no title)',
      start,
      end,
      allDay: item.startDate.isDate,
      location: item.location || '',
      calendar,
      color,
      busy: String(item.component.getFirstPropertyValue('transp') ?? '').toUpperCase() !== 'TRANSPARENT',
    })
  }

  for (const vevent of vevents) {
    if (vevent.hasProperty('recurrence-id')) continue
    const event = new ICAL.Event(vevent, { exceptions: exceptions.get(vevent.getFirstPropertyValue('uid')) ?? [], strictExceptions: false })
    if (!event.startDate) continue
    if (!event.isRecurring()) {
      push(event, event.startDate.toJSDate(), endOf(event.startDate, event.endDate), event)
      continue
    }
    const iterator = event.iterator()
    for (let i = 0, next; i < MAX_OCCURRENCES && (next = iterator.next()); i++) {
      const details = event.getOccurrenceDetails(next)
      const start = details.startDate.toJSDate()
      // Occurrences come in order of their original slot; a moved exception can land
      // earlier, so stop only once the original slot itself is past the window.
      if (next.toJSDate() >= to && start >= to) break
      push(event, start, endOf(details.startDate, details.endDate), details.item)
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

function endOf(start, end) {
  if (end && end.compare(start) > 0) return end.toJSDate()
  // No DTEND/DURATION: RFC 5545 §3.6.1 says a date lasts one day, a date-time zero time.
  if (start.isDate) {
    const next = start.clone()
    next.day += 1
    return next.toJSDate()
  }
  return start.toJSDate()
}

function uid(kind, task) {
  return `${createHash('sha1').update(`${kind}|${task.section}|${task.title}`).digest('hex').slice(0, 20)}@orb`
}

/**
 * Orb's own feed: a timed event for every planned block, and a marker on the due
 * date of every open task. UIDs come from the task's title and section, so a
 * calendar app updates the same event when a date moves instead of duplicating it.
 */
export function buildIcs(tasks, { now = new Date(), name = 'Orb' } = {}) {
  const cal = new ICAL.Component(['vcalendar', [], []])
  cal.updatePropertyWithValue('prodid', '-//Orb//Orb to-do//EN')
  cal.updatePropertyWithValue('version', '2.0')
  cal.updatePropertyWithValue('calscale', 'GREGORIAN')
  cal.updatePropertyWithValue('method', 'PUBLISH')
  cal.updatePropertyWithValue('x-wr-calname', name)
  cal.updatePropertyWithValue('x-published-ttl', 'PT15M')
  const stamp = ICAL.Time.fromJSDate(now, true)

  const add = (id, summary, start, end, busy, description) => {
    const vevent = new ICAL.Component('vevent')
    const event = new ICAL.Event(vevent)
    event.uid = id
    event.summary = summary
    event.startDate = start
    event.endDate = end
    vevent.updatePropertyWithValue('dtstamp', stamp)
    vevent.updatePropertyWithValue('transp', busy ? 'OPAQUE' : 'TRANSPARENT')
    if (description) event.description = description
    cal.addSubcomponent(vevent)
  }

  for (const task of tasks) {
    if (task.done || task.cancelled) continue
    const where = task.section ? `Orb · ${task.section}` : 'Orb'
    if (task.plan) {
      const start = parseLocal(task.plan.start)
      add(uid('plan', task), task.title, ICAL.Time.fromJSDate(start, true),
        ICAL.Time.fromJSDate(addMinutes(start, task.plan.minutes), true), true, where)
    }
    if (task.due) {
      if (task.due.length === 10) {
        const start = ICAL.Time.fromDateString(task.due)
        const end = start.clone()
        end.day += 1
        add(uid('due', task), `Due: ${task.title}`, start, end, false, where)
      } else {
        const start = parseLocal(task.due)
        add(uid('due', task), `Due: ${task.title}`, ICAL.Time.fromJSDate(start, true),
          ICAL.Time.fromJSDate(addMinutes(start, 15), true), false, where)
      }
    }
  }
  // RFC 5545 requires CRLF line endings; ical.js folds long lines at 75 octets.
  return cal.toString().replace(/\r?\n/g, '\r\n') + '\r\n'
}

/**
 * Everything on one local day: calendar events, planned blocks and due tasks,
 * all-day items first, then by time.
 */
export function agenda(day, { tasks = [], events = [] }) {
  const dayStart = parseLocal(day)
  const dayEnd = parseLocal(day)
  dayEnd.setDate(dayEnd.getDate() + 1)
  const items = []
  for (const event of events) {
    // A zero-length event (no DTEND) still belongs to the day it starts on.
    const ends = event.end > event.start ? event.end : new Date(event.start.getTime() + 1)
    if (ends <= dayStart || event.start >= dayEnd) continue
    items.push({ kind: 'event', allDay: event.allDay, start: event.start, end: event.end, title: event.title, calendar: event.calendar, color: event.color, location: event.location, id: event.id })
  }
  for (const task of tasks) {
    if (task.cancelled) continue
    if (task.plan && task.plan.start.slice(0, 10) === day) {
      const start = parseLocal(task.plan.start)
      items.push({ kind: 'plan', allDay: false, start, end: addMinutes(start, task.plan.minutes), title: task.title, task })
    }
    if (task.due && task.due.slice(0, 10) === day) {
      const timed = task.due.length > 10
      items.push({ kind: 'due', allDay: !timed, start: timed ? parseLocal(task.due) : dayStart, title: task.title, task })
    }
  }
  const rank = (item) => (item.allDay ? 0 : 1)
  return items.sort((a, b) => rank(a) - rank(b) || a.start - b.start || a.title.localeCompare(b.title))
}

/**
 * Free slots of at least `minutes` between `dayStart` and `dayEnd` (HH:MM) on each
 * day from `from` for `days` days, skipping time already past and every busy
 * interval (timed events that are not marked free, plus planned blocks).
 */
export function findFreeTime({ from, days = 1, minutes, dayStart = '08:00', dayEnd = '22:00', tasks = [], events = [], now = new Date(), limit = 12 }) {
  const busy = [
    ...events.filter((e) => !e.allDay && e.busy !== false).map((e) => ({ start: e.start, end: e.end })),
    ...tasks.filter((t) => t.plan && !t.done && !t.cancelled).map((t) => {
      const start = parseLocal(t.plan.start)
      return { start, end: addMinutes(start, t.plan.minutes) }
    }),
  ].sort((a, b) => a.start - b.start)

  const slots = []
  for (let d = 0; d < days && slots.length < limit; d++) {
    const date = parseLocal(from)
    date.setDate(date.getDate() + d)
    const day = localDate(date)
    let cursor = parseLocal(`${day}T${dayStart}`)
    const close = parseLocal(`${day}T${dayEnd}`)
    if (cursor < now) cursor = roundUp(now)
    for (const block of busy) {
      if (block.end <= cursor || block.start >= close) continue
      if (block.start - cursor >= minutes * 60_000) slots.push({ start: cursor, end: block.start })
      if (block.end > cursor) cursor = block.end
    }
    if (close - cursor >= minutes * 60_000) slots.push({ start: cursor, end: close })
  }
  return slots.slice(0, limit)
}

/** Next quarter hour, so suggested slots start at :00/:15/:30/:45. */
function roundUp(date) {
  const step = 15 * 60_000
  return new Date(Math.ceil(date.getTime() / step) * step)
}
