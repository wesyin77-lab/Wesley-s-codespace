/**
 * Natural-language quick add: "book friday dinner fri 7pm #life" →
 * { title: 'book friday dinner', due: '2026-10-30T19:00', section: 'life' }.
 *
 * Dates come from chrono-node. Three corrections on top of it, each found by
 * feeding it real to-do lines (see test/quickadd.test.js):
 *  - "10/21" typed on Oct 25 means the date that just passed (an overdue
 *    assignment), not next year's.
 *  - "at 3" with no am/pm means 3 pm, not 3 am.
 *  - A date phrase in the middle ("book friday dinner") stays in the title; only
 *    a trailing one ("... by fri") is removed from it.
 * Text in "double quotes" is never read as a date.
 */

import * as chrono from 'chrono-node'
import { localDate, localDateTime } from './dates.js'
import { splitBody } from './format.js'

const CONNECTOR = /\s+(?:due|by|on|at|before)\s*$/i
const SECTION_TAG = /(^|\s)#([\p{L}\p{N}_-]+)/gu
const HALF_YEAR_MS = 183 * 24 * 3600 * 1000

export function quickAdd(input, { now = new Date(), sections = [] } = {}) {
  let text = String(input ?? '').trim()

  let section
  let newSection = false
  text = text.replace(SECTION_TAG, (whole, lead, name) => {
    if (section !== undefined) return whole
    const known = sections.find((s) => s.toLowerCase() === name.toLowerCase())
    section = known ?? name
    newSection = known === undefined
    return lead
  }).trim()

  // Explicit tags (due:..., plan:...) win over anything chrono would guess.
  const explicit = splitBody(text)
  text = explicit.title
  let due = explicit.due
  let dueText

  if (!due) {
    const masked = text.replace(/"[^"]*"/g, (q) => ' '.repeat(q.length))
    const results = chrono.casual.parse(masked, now, { forwardDate: true })
    const hit = results[results.length - 1]
    if (hit) {
      const date = correct(hit, now)
      due = hit.start.isCertain('hour') ? localDateTime(date) : localDate(date)
      dueText = hit.text
      const end = hit.index + hit.text.length
      if (masked.slice(end).trim() === '') {
        text = text.slice(0, hit.index).replace(CONNECTOR, '').trim()
      }
    }
  }

  const title = text.replace(/"([^"]*)"/g, '$1').replace(/\s+/g, ' ').trim()
  return { title, due, plan: explicit.plan, section, newSection, dueText }
}

function correct(hit, now) {
  const start = hit.start
  const date = start.date()
  if (!start.isCertain('year') && start.isCertain('month') && date - now > HALF_YEAR_MS) {
    date.setFullYear(date.getFullYear() - 1)
  }
  if (start.isCertain('hour') && !start.isCertain('meridiem')) {
    const hour = date.getHours()
    if (hour >= 1 && hour <= 7) date.setHours(hour + 12)
  }
  return date
}
