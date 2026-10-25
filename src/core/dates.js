/**
 * Local-time date helpers. The file stores wall-clock times without a zone
 * (`2026-10-27T15:00`), meaning "in whatever zone this computer is in", which is
 * what a person means when they write a due date.
 */

const pad = (n) => String(n).padStart(2, '0')

export function localDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function localDateTime(date) {
  return `${localDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `2026-10-27` or `2026-10-27T15:00` → Date at that local wall-clock time. */
export function parseLocal(text) {
  const [d, t = '00:00'] = text.split('T')
  const [y, m, day] = d.split('-').map(Number)
  const [h, min] = t.split(':').map(Number)
  return new Date(y, m - 1, day, h, min)
}

export function addDays(dateText, days) {
  const date = parseLocal(dateText)
  date.setDate(date.getDate() + days)
  return localDate(date)
}

export function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60_000)
}

/** Where an open task's due date sits relative to `now`. */
export function dueStatus(due, now) {
  if (!due) return undefined
  const today = localDate(now)
  const day = due.slice(0, 10)
  if (day < today) return 'overdue'
  if (day > today) return 'upcoming'
  if (due.length > 10 && parseLocal(due) < now) return 'overdue'
  return 'today'
}

/** Monday-first is wrong for many people; follow the locale's convention where available. */
export function weekStartsOn(locale) {
  try {
    const info = new Intl.Locale(locale).getWeekInfo?.() ?? new Intl.Locale(locale).weekInfo
    if (info?.firstDay) return info.firstDay % 7
  } catch {
    // Older runtimes have no week info; Sunday is the US default.
  }
  return 0
}
