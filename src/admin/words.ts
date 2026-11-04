// How the admin site says times and codes to people: the company's clock, and words instead of identifiers.
import type { Db } from "../db/client.js";
import { getTenantSettings } from "../org/org.js";
import { parseCron } from "../routines/cron.js";

export type When = (d: Date | null | undefined) => string;

/** "today 12:30 pm", "yesterday 4:05 pm", "Tue 4 Nov, 9:00 am", or "4 Nov 2025" once it is far back. */
export function whenIn(timezone: string, now = new Date()): When {
  const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-AU", { timeZone: timezone, ...o });
  const day = f({ year: "numeric", month: "2-digit", day: "2-digit" });
  const time = f({ hour: "numeric", minute: "2-digit" });
  const date = f({ weekday: "short", day: "numeric", month: "short" });
  const full = f({ day: "numeric", month: "short", year: "numeric" });
  const today = day.format(now);
  const yesterday = day.format(new Date(now.getTime() - 86_400_000));
  return (d) => {
    if (!d) return "";
    const k = day.format(d);
    if (k === today) return `today ${time.format(d)}`;
    if (k === yesterday) return `yesterday ${time.format(d)}`;
    if (Math.abs(now.getTime() - d.getTime()) < 180 * 86_400_000) return `${date.format(d).replace(",", "")}, ${time.format(d)}`;
    return full.format(d);
  };
}

export const whenFor = async (db: Db, tenantId: string): Promise<When> => whenIn((await getTenantSettings(db, tenantId)).timezone);

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const clock = (h: number, m: number) => `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;

/** A cron schedule in words for the common shapes ("weekdays 8:00 am", "every day 6:30 pm", "Mondays 9:00 am"); anything else stays as written. */
export function cronWords(schedule: string): string {
  let c;
  try {
    c = parseCron(schedule);
  } catch {
    return schedule;
  }
  const [min, hour, , mon, dow] = c.fields;
  if (min.size !== 1 || hour.size !== 1 || mon.size !== 12 || !c.domAny) return schedule;
  const at = clock([...hour][0]!, [...min][0]!);
  const days = [...dow].filter((d) => d < 7).sort();
  const same = (xs: number[]) => days.length === xs.length && xs.every((x, i) => days[i] === x);
  if (c.dowAny || same([0, 1, 2, 3, 4, 5, 6])) return `every day ${at}`;
  if (same([1, 2, 3, 4, 5])) return `weekdays ${at}`;
  if (days.length === 1) return `${DAYS[days[0]!]}s ${at}`;
  return `${days.map((d) => DAYS[d]!.slice(0, 3)).join(", ")} ${at}`;
}

const CAPABILITY: Record<string, string> = {
  "mail.read": "read mail", "mail.send": "send mail", "calendar.read": "read the calendar", "calendar.write": "change the calendar",
  "chats.read": "read Teams chats", "files.read": "read files", "files.write": "change files",
};
export const capabilityWords = (c: string): string => CAPABILITY[c] ?? c.replace(/[._]/g, " ");

export const chatTypeWords = (t: string): string => (t === "personal" ? "one-to-one" : t === "groupChat" ? "group" : t === "channel" ? "channel" : t);

/** An MCP tool's recorded arguments as "key value · key value", so a summary does not show JSON. */
export function inputWords(summary: string): string {
  const i = summary.indexOf(" {");
  if (i < 0 || !summary.endsWith("}")) return summary;
  try {
    const args = JSON.parse(summary.slice(i + 1)) as Record<string, unknown>;
    const parts = Object.entries(args).map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`);
    const tool = summary.slice(0, i).replace(/[_-]+/g, " ");
    return parts.length ? `${tool}: ${parts.join(" · ")}` : tool;
  } catch {
    return summary; // a truncated summary is not JSON
  }
}
