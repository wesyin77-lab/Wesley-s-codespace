/**
 * Calendar subscriptions: download each feed URL, keep the last good copy on disk
 * (so the calendar still shows while offline), and parse cached copies on demand.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parseIcs } from './calendar.js'

const PALETTE = ['#3573d0', '#0f9b8e', '#d9730d', '#7a5af5', '#c2417a', '#5b8a1e']

export function normalizeFeedUrl(url) {
  const trimmed = String(url ?? '').trim().replace(/^webcals?:\/\//i, 'https://')
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('That is not a web address.')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Calendar links must start with https:// or webcal://')
  }
  return parsed.toString()
}

function cacheFile(paths, url) {
  return join(paths.cache, `${createHash('sha1').update(url).digest('hex').slice(0, 16)}.ics`)
}

export function feedColor(feed, index) {
  return feed.color || PALETTE[index % PALETTE.length]
}

/** Fetch every feed; returns a status per feed. A failed fetch keeps the old cache. */
export async function refreshFeeds(feeds, paths, { fetchImpl = fetch } = {}) {
  await mkdir(paths.cache, { recursive: true })
  return Promise.all(feeds.map(async (feed) => {
    try {
      const url = normalizeFeedUrl(feed.url)
      const response = await fetchImpl(url, {
        headers: { 'user-agent': 'Orb-calendar/0.1', accept: 'text/calendar, */*' },
        signal: AbortSignal.timeout(20_000),
      })
      if (!response.ok) throw new Error(`The server answered ${response.status}.`)
      const text = await response.text()
      if (!/^\s*BEGIN:VCALENDAR/i.test(text)) throw new Error('That link did not return a calendar (.ics).')
      const file = cacheFile(paths, url)
      await writeFile(`${file}.tmp`, text)
      await rename(`${file}.tmp`, file)
      return { url: feed.url, ok: true, fetchedAt: new Date().toISOString() }
    } catch (error) {
      return { url: feed.url, ok: false, error: error.name === 'TimeoutError' ? 'Timed out.' : error.message }
    }
  }))
}

/** Events in [from, to) from every cached feed. Unreadable feeds are skipped, not fatal. */
export async function loadFeedEvents(feeds, paths, { from, to }) {
  const events = []
  const problems = []
  await Promise.all(feeds.map(async (feed, index) => {
    let text
    try {
      text = await readFile(cacheFile(paths, normalizeFeedUrl(feed.url)), 'utf8')
    } catch {
      return
    }
    try {
      events.push(...parseIcs(text, { from, to, calendar: feed.name || 'Calendar', color: feedColor(feed, index) }))
    } catch (error) {
      problems.push({ url: feed.url, error: `Could not read this calendar: ${error.message}` })
    }
  }))
  return { events: events.sort((a, b) => a.start - b.start), problems }
}
