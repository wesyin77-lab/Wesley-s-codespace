process.env.TZ = 'Asia/Shanghai'

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeFeedUrl, refreshFeeds, loadFeedEvents, OUTLOOK_HELP } from '../src/core/feeds.js'
import { parseIcs } from '../src/core/calendar.js'

const outlookIcs = await readFile(new URL('./fixtures/outlook.ics', import.meta.url), 'utf8')
const ICS_LINK = 'https://outlook.office365.com/owa/calendar/abc123@school.edu/def456/calendar.ics'

const fakeFetch = (status, body, contentType = 'text/calendar') => async () =>
  new Response(body, { status, headers: { 'content-type': contentType } })

async function cacheDir() {
  return { cache: join(await mkdtemp(join(tmpdir(), 'orb-feeds-')), 'cache') }
}

describe('Outlook school calendars', () => {
  it('reads an Outlook/Exchange feed: byte-order mark, Windows time-zone names, all-day events', () => {
    assert.equal(outlookIcs.charCodeAt(0), 0xfeff)
    const events = parseIcs(outlookIcs, { from: new Date('2026-10-26T00:00:00+08:00'), to: new Date('2026-11-03T00:00:00+08:00') })
    assert.deepEqual(events.map((e) => `${e.title} ${e.start.getDate()} ${e.start.getHours()}:00`), [
      'AP Physics C 26 8:00', 'AP Physics C 28 8:00', 'AP Physics C 30 8:00',
      'No school - Teacher PD Day 2 0:00', 'AP Physics C 2 8:00',
    ])
    assert.equal(events.find((e) => e.title.startsWith('No school')).allDay, true)
  })

  it('swaps the HTML link from "Publish a calendar" for the ICS one', () => {
    assert.equal(normalizeFeedUrl(ICS_LINK.replace('.ics', '.html')), ICS_LINK)
    assert.equal(normalizeFeedUrl(`  <${ICS_LINK}>  `), ICS_LINK)
  })

  it('explains, instead of failing silently, when the Outlook website address is pasted', () => {
    assert.throws(() => normalizeFeedUrl('https://outlook.office.com/calendar/view/month'), (e) => e.message === OUTLOOK_HELP)
  })

  it('adds and shows a working Outlook feed end to end', async () => {
    const paths = await cacheDir()
    const [status] = await refreshFeeds([{ url: ICS_LINK }], paths, { fetchImpl: fakeFetch(200, outlookIcs) })
    assert.equal(status.ok, true, status.error)
    const { events, problems } = await loadFeedEvents([{ url: ICS_LINK, name: 'School' }], paths, {
      from: new Date('2026-10-26T00:00:00+08:00'), to: new Date('2026-10-27T00:00:00+08:00'),
    })
    assert.deepEqual(problems, [])
    assert.deepEqual(events.map((e) => [e.title, e.calendar]), [['AP Physics C', 'School']])
  })

  it('a sign-in page instead of a calendar gets the Outlook instructions', async () => {
    const [status] = await refreshFeeds([{ url: ICS_LINK }], await cacheDir(), {
      fetchImpl: fakeFetch(200, '<!DOCTYPE html><html>login.microsoftonline.com</html>', 'text/html'),
    })
    assert.equal(status.error, OUTLOOK_HELP)
  })

  it('a refused link says it may be blocked or unpublished', async () => {
    const [status] = await refreshFeeds([{ url: ICS_LINK }], await cacheDir(), { fetchImpl: fakeFetch(403, 'Forbidden', 'text/plain') })
    assert.match(status.error, /refused the link \(403\).*school may block publishing/)
  })

  it('no connection says to check internet / VPN', async () => {
    const [status] = await refreshFeeds([{ url: ICS_LINK }], await cacheDir(), {
      fetchImpl: async () => { throw new TypeError('fetch failed') },
    })
    assert.match(status.error, /Couldn't reach the calendar server.*VPN/)
  })

  it('a calendar it cannot read is reported when added, not skipped later', async () => {
    const [status] = await refreshFeeds([{ url: ICS_LINK }], await cacheDir(), {
      fetchImpl: fakeFetch(200, 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:garbage\r\n'),
    })
    assert.match(status.error, /couldn't read it/)
  })
})
