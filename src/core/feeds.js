/**
 * Calendar subscriptions: download each feed URL, keep the last good copy on disk
 * (so the calendar still shows while offline), and parse cached copies on demand.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parseIcs } from './calendar.js'

const PALETTE = ['#3573d0', '#0f9b8e', '#d9730d', '#7a5af5', '#c2417a', '#5b8a1e']

const OUTLOOK_HOSTS = /(^|\.)(outlook\.office365\.com|outlook\.office\.com|outlook\.live\.com)$/i

export function normalizeFeedUrl(url) {
  // People paste links wrapped in quotes or <angle brackets>, or with stray spaces.
  const trimmed = String(url ?? '').trim().replace(/^[<"']+|[>"']+$/g, '').trim().replace(/^webcals?:\/\//i, 'https://')
  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('That is not a web address.')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Calendar links must start with https:// or webcal://')
  }
  if (OUTLOOK_HOSTS.test(parsed.hostname)) {
    // "Publish a calendar" gives an HTML link and an ICS link with the same path;
    // the HTML one is a web page. Use the ICS one.
    if (/\/calendar\.html$/i.test(parsed.pathname)) parsed.pathname = parsed.pathname.replace(/\.html$/i, '.ics')
    else if (!/\.ics$/i.test(parsed.pathname)) throw new Error(OUTLOOK_HELP)
  }
  return parsed.toString()
}

export const OUTLOOK_HELP = 'That\'s the Outlook website, not a calendar feed. In Outlook on the web: Settings (⚙) → Calendar → '
  + 'Shared calendars → "Publish a calendar" → choose your calendar and "Can view all details" → Publish, '
  + 'then copy the ICS link (it ends in .ics). If there\'s no "Publish a calendar" section, your school has turned it off.'

function explainStatus(status, url) {
  const outlook = OUTLOOK_HOSTS.test(new URL(url).hostname)
  if (status === 401 || status === 403) {
    return outlook
      ? `Outlook refused the link (${status}). It may have been unpublished or reset, or your school may block publishing calendars outside school. Publish it again and copy the new ICS link.`
      : `The calendar server refused the link (${status}). It may be private, expired or reset; copy a fresh link.`
  }
  if (status === 404) return 'Nothing at that link (404). It may have been unpublished or copied incompletely.'
  return `The calendar server answered ${status}. Try again later.`
}

/** Turn whatever a feed URL returned into calendar text, or a clear reason it isn't one. */
export function checkFeedResponse(text, contentType, url) {
  const body = String(text).replace(/^\uFEFF/, '')
  if (/^\s*BEGIN:VCALENDAR/i.test(body)) return body
  if (/html/i.test(contentType ?? '') || /^\s*</.test(body)) {
    if (OUTLOOK_HOSTS.test(new URL(url).hostname) || /login\.microsoftonline\.com/i.test(body)) throw new Error(OUTLOOK_HELP)
    throw new Error('That link opened a web page (probably a sign-in page), not a calendar. Use the calendar\'s "iCal"/"ICS" subscription link instead.')
  }
  throw new Error('That link did not return a calendar (.ics).')
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
      if (!response.ok) throw new Error(explainStatus(response.status, url))
      const text = checkFeedResponse(await response.text(), response.headers.get('content-type'), url)
      // Parse it now, so a calendar Orb can't read is reported when you add it, not silently skipped later.
      try {
        parseIcs(text, { from: new Date(), to: new Date(Date.now() + 86_400_000) })
      } catch (error) {
        throw new Error(`Downloaded the calendar but couldn't read it: ${error.message}`)
      }
      const file = cacheFile(paths, url)
      await writeFile(`${file}.tmp`, text)
      await rename(`${file}.tmp`, file)
      return { url: feed.url, ok: true, fetchedAt: new Date().toISOString() }
    } catch (error) {
      return { url: feed.url, ok: false, error: describeFailure(error) }
    }
  }))
}

function describeFailure(error) {
  if (error.name === 'TimeoutError') return 'Timed out. If this calendar needs a VPN where you are, make sure it is on.'
  // Network-level failures (no connection, DNS, blocked host) surface as a bare "fetch failed".
  if (/fetch failed|ERR_|ENOTFOUND|ECONNRE|ETIMEDOUT/i.test(error.message)) {
    return 'Couldn\'t reach the calendar server. Check your internet connection (and VPN, if this service needs one).'
  }
  return error.message
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
