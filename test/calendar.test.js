// Run in a fixed zone different from the feed's, so time-zone conversion is really exercised.
process.env.TZ = 'America/Los_Angeles'

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ICAL from 'ical.js'
import { parseIcs, buildIcs, agenda, findFreeTime } from '../src/core/calendar.js'
import { parse } from '../src/core/format.js'

const google = readFileSync(new URL('./fixtures/google.ics', import.meta.url), 'utf8')
const from = new Date('2026-10-25T00:00:00-07:00')
const to = new Date('2026-11-08T00:00:00-08:00')
const events = parseIcs(google, { from, to, calendar: 'School', color: '#3573d0' })
const titled = (title) => events.filter((e) => e.title === title)

describe('reading a Google Calendar feed', () => {
  it('expands a weekly class, honouring EXDATE and a moved instance', () => {
    const chem = titled('AP Chem').map((e) => e.start.toISOString())
    // Mon/Wed 09:00 New York. 26 Oct (EDT, -4) → 13:00Z; 28 Oct is EXDATEd;
    // 2 Nov moved; 4 Nov is after the DST change (EST, -5) → 14:00Z.
    assert.deepEqual(chem, ['2026-10-26T13:00:00.000Z', '2026-11-04T14:00:00.000Z'])
    const moved = titled('AP Chem (moved)')
    assert.equal(moved.length, 1)
    assert.equal(moved[0].start.toISOString(), '2026-11-04T16:00:00.000Z')
  })

  it('keeps all-day events on their date, in local time', () => {
    const [spirit] = titled('Spirit day')
    assert.equal(spirit.allDay, true)
    assert.equal(spirit.start.getDate(), 30)
    assert.equal(spirit.busy, false)
  })

  it('drops cancelled events and marks free ones as not busy', () => {
    assert.equal(titled('Cancelled meeting').length, 0)
    assert.equal(titled('Optional study hall')[0].busy, false)
    assert.equal(titled('Robotics club')[0].busy, true)
  })

  it('only returns events inside the window', () => {
    const later = parseIcs(google, { from: new Date('2026-12-20'), to: new Date('2027-01-10') })
    assert.equal(later.filter((e) => e.title === 'AP Chem').length, 0, 'UNTIL ends the series')
  })
})

const todo = `## study
- [ ] chem lab report due:2026-10-27 plan:2026-10-26T19:00/1h
- [ ] read ch. 5 due:2026-10-26T08:00
- [x] HW 6 due:2026-10-21 done:2026-10-21
`

describe('publishing Orb\'s feed', () => {
  const text = buildIcs(parse(todo).tasks.map((t) => ({ ...t })), { now: new Date('2026-10-25T17:00:00Z') })

  it('is valid iCalendar with CRLF line endings that ical.js reads back', () => {
    assert.ok(text.startsWith('BEGIN:VCALENDAR\r\n'))
    assert.ok(!/[^\r]\n/.test(text))
    const back = parseIcs(text, { from, to })
    assert.deepEqual(back.map((e) => e.title).sort(), ['Due: chem lab report', 'Due: read ch. 5', 'chem lab report'])
  })

  it('puts a planned block at the right absolute time, and leaves done tasks out', () => {
    const back = parseIcs(text, { from, to })
    const block = back.find((e) => e.title === 'chem lab report')
    assert.equal(block.start.toISOString(), '2026-10-27T02:00:00.000Z', '19:00 Los Angeles (PDT)')
    assert.equal(block.end - block.start, 60 * 60_000)
    assert.equal(block.busy, true)
    assert.ok(!back.some((e) => e.title.includes('HW 6')))
  })

  it('uses stable UIDs and has every property RFC 5545 requires', () => {
    const again = buildIcs(parse(todo).tasks, { now: new Date('2026-10-26T00:00:00Z') })
    const uids = (t) => [...t.matchAll(/^UID:(.*)$/gm)].map((m) => m[1].trim())
    assert.deepEqual(uids(again), uids(text))
    const cal = new ICAL.Component(ICAL.parse(text))
    assert.ok(cal.getFirstPropertyValue('prodid'))
    assert.equal(cal.getFirstPropertyValue('version'), '2.0')
    for (const vevent of cal.getAllSubcomponents('vevent')) {
      for (const prop of ['uid', 'dtstamp', 'dtstart']) assert.ok(vevent.hasProperty(prop), prop)
    }
  })
})

describe('agenda and free time', () => {
  const tasks = parse(todo).tasks

  it('merges events, blocks and due tasks for a day, all-day first', () => {
    const items = agenda('2026-10-26', { tasks, events })
    assert.deepEqual(items.map((i) => `${i.kind}:${i.title}`), [
      'event:AP Chem', // 06:00 local
      'due:read ch. 5', // 08:00
      'event:Optional study hall', // 12:00 local
      'plan:chem lab report', // 19:00
    ])
  })

  it('finds gaps around busy events and planned blocks, ignoring free events', () => {
    const slots = findFreeTime({
      from: '2026-10-26', minutes: 60, tasks, events,
      dayStart: '08:00', dayEnd: '22:00', now: new Date('2026-10-26T07:00:00-07:00'),
    })
    const fmt = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    // Busy: 19:00–20:00 (plan). AP Chem ends 06:50, study hall is free.
    assert.deepEqual(slots.map((s) => `${fmt(s.start)}-${fmt(s.end)}`), ['08:00-19:00', '20:00-22:00'])
  })

  it('never offers time that has already passed', () => {
    const slots = findFreeTime({ from: '2026-10-26', minutes: 30, now: new Date('2026-10-26T21:20:00-07:00') })
    assert.equal(slots[0].start.getHours(), 21)
    assert.equal(slots[0].start.getMinutes(), 30)
  })
})
