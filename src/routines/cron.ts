export type Cron = { fields: [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>]; domAny: boolean; dowAny: boolean };

const RANGES: [string, number, number][] = [["minute", 0, 59], ["hour", 0, 23], ["day of month", 1, 31], ["month", 1, 12], ["day of week", 0, 7]];

function parseField(text: string, [name, lo, hi]: [string, number, number]): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`Invalid ${name} field "${text}"`);
    const star = part.startsWith("*");
    const a = star ? lo : Number(m[1]);
    const b = star ? hi : m[2] !== undefined ? Number(m[2]) : m[3] !== undefined ? hi : a;
    const step = m[3] !== undefined ? Number(m[3]) : 1;
    if (a < lo || b > hi || a > b || step < 1) throw new Error(`${name} must be ${lo}-${hi}: "${part}"`);
    for (let i = a; i <= b; i += step) out.add(i);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("A schedule needs 5 fields: minute hour day-of-month month day-of-week");
  const f = parts.map((p, i) => parseField(p, RANGES[i])) as Cron["fields"];
  if (f[4].has(7)) f[4].add(0);
  return { fields: f, domAny: parts[2].startsWith("*"), dowAny: parts[4].startsWith("*") };
}

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function cronMatches(cron: Cron, at: Date, timeZone: string): boolean {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", minute: "numeric", hour: "numeric", day: "numeric", month: "numeric", weekday: "short" })
      .formatToParts(at).map((p) => [p.type, p.value]),
  );
  const [min, hour, dom, mon, dow] = cron.fields;
  if (!min.has(Number(parts.minute)) || !hour.has(Number(parts.hour)) || !mon.has(Number(parts.month))) return false;
  const d = dom.has(Number(parts.day));
  const w = dow.has(WEEKDAYS.indexOf(parts.weekday));
  return cron.domAny || cron.dowAny ? d && w : d || w;
}

/**
 * The next time the expression matches after `from`, within `maxDays` (a week covers every daily and weekly shape;
 * rarer ones answer undefined rather than scanning a year). Minute resolution, in the tenant's zone.
 */
export function nextRun(expr: string, timeZone: string, from: Date, maxDays = 8): Date | undefined {
  let cron: Cron;
  try {
    cron = parseCron(expr);
  } catch {
    return undefined;
  }
  const start = Math.ceil((from.getTime() + 1) / 60_000) * 60_000;
  const end = start + maxDays * 86_400_000;
  for (let t = start; t <= end; t += 60_000) {
    const d = new Date(t);
    if (cronMatches(cron, d, timeZone)) return d;
  }
  return undefined;
}
