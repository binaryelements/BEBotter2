const OPEN = 9 * 60
const CLOSE = 17 * 60

function localParts(t: number, timeZone: string) {
  const p: Record<string, string> = {}
  for (const x of new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(t))) p[x.type] = x.value
  // The same wall clock read as if it were UTC.
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second)
  return { y: +p.year, m: +p.month, d: +p.day, wall }
}

// Instant at which the local wall clock in `timeZone` reads y-m-d plus `minutes`.
// shortcut: a wall time skipped by a DST jump resolves to the instant just after it; none occur at 09:00 or 17:00 in practice.
function atLocal(y: number, m: number, d: number, minutes: number, timeZone: string): number {
  const target = Date.UTC(y, m - 1, d, 0, minutes)
  let t = target
  for (let i = 0; i < 2; i++) t = target - (localParts(t, timeZone).wall - t)
  return t
}

export function waitUntil(start: Date, minutes: number, businessHours: boolean, timezone: string, holidays: string[]): Date {
  if (!businessHours) return new Date(start.getTime() + minutes * 60_000)
  let cur = start.getTime()
  let remaining = minutes
  const { y, m, d } = localParts(cur, timezone)
  // Day cursor in UTC arithmetic: only the calendar date matters here.
  const day = new Date(Date.UTC(y, m - 1, d))
  for (let guard = 0; guard < 366 * 20; guard++, day.setUTCDate(day.getUTCDate() + 1)) {
    const iso = day.toISOString().slice(0, 10)
    const dow = day.getUTCDay()
    if (dow === 0 || dow === 6 || holidays.includes(iso)) continue
    const open = atLocal(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), OPEN, timezone)
    const close = atLocal(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), CLOSE, timezone)
    cur = Math.max(cur, open)
    if (cur >= close) continue
    const avail = (close - cur) / 60_000
    if (remaining <= avail) return new Date(cur + remaining * 60_000)
    remaining -= avail
    cur = close
  }
  throw new Error('waitUntil: no business time found within 20 years; check holidays')
}
