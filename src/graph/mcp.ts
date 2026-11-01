import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { GraphCapability } from "../db/schema.js";
import { GraphError, graphFetch } from "./client.js";
import type { GraphDeps } from "./client.js";

/**
 * graphToken: the token of the turn running now, read on every call; a warm engine outlives the turn that started it.
 * signInLost: Graph refused the token, so the turn signs the person out and their next message brings the sign-in card.
 */
type Ctx = { graphToken: () => Promise<string | undefined>; signInLost?: () => void };

const PREVIEW = 300;
const BODY = 20_000;
const DAY = 86_400_000;
const MAX_UPLOAD = 4 * 1024 * 1024;
const SIGN_IN_AGAIN = "Not done: the person must sign in again to Microsoft 365. Ask them to sign in again; do not retry until they have.";

/** A call refused before reaching Graph; its message is for the model. */
class Refusal extends Error {}

/** A tool result that is already MCP content (an image), passed through as it is. */
class Content {
  constructor(readonly content: { type: "image"; data: string; mimeType: string }[]) {}
}
const ok = (v: unknown) => (v instanceof Content ? { content: v.content } : { content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v) }] });
const fail = (e: unknown) => {
  // a GraphError's message is status and code only; anything else may quote what it saw, so only its name is logged
  if (e instanceof GraphError) console.error("m365 tool failed:", e.message);
  else if (!(e instanceof Refusal)) console.error("m365 tool failed:", e instanceof Error ? e.name : "unknown");
  const text =
    e instanceof Refusal ? e.message
    : e instanceof GraphError ? (e.status === 401 ? SIGN_IN_AGAIN : `Not done: Microsoft 365 answered ${e.status} ${e.code}.`)
    : "Microsoft 365 error";
  return { isError: true, content: [{ type: "text" as const, text }] };
};

const qs = (p: Record<string, string | number>) => Object.entries(p).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
const enc = encodeURIComponent;
const READ_LIMIT = BODY * 4; // bytes: 4 per character at most

/** A Graph id as a path segment; "." or ".." would climb the path once the URL is normalised. */
const idPart = (id: string) => {
  if (/^\.*$/.test(id)) throw new Refusal("Not done: not an id.");
  return enc(id);
};

/** At most `max` bytes of a body, then the stream is dropped, whatever the host does with Range. */
async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader && size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader?.cancel();
  return Buffer.concat(chunks).subarray(0, max).toString("utf8");
}

type Address = { emailAddress?: { name?: string; address?: string } };
const who = (r?: Address) => {
  const a = r?.emailAddress;
  return a?.name && a.name !== a.address ? `${a.name} <${a.address}>` : a?.address;
};
const recipients = (list: string[] = []) => list.map((address) => ({ emailAddress: { address } }));

type Message = { id: string; hasAttachments?: boolean; subject?: string; from?: Address; toRecipients?: Address[]; ccRecipients?: Address[]; receivedDateTime?: string; bodyPreview?: string; body?: { content?: string } };
const MAIL_FIELDS = "id,subject,from,toRecipients,receivedDateTime,bodyPreview";
const mail = (m: Message) => ({ id: m.id, subject: m.subject, from: who(m.from), to: m.toRecipients?.map(who), date: m.receivedDateTime, preview: m.bodyPreview?.slice(0, PREVIEW) });

type When = { dateTime: string; timeZone: string };
const at = (d?: When) => d && (d.timeZone === "UTC" ? `${d.dateTime}Z` : `${d.dateTime} ${d.timeZone}`);
const instant = (s: string) => {
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Refusal(`Not a date and time: ${s}. Use ISO 8601 with an offset, e.g. 2026-11-02T09:00:00Z.`);
  return t;
};
const utc = (t: number): When => ({ dateTime: new Date(t).toISOString().slice(0, -1), timeZone: "UTC" });
const span = (from: string, to: string, maxDays: number) => {
  const [a, b] = [instant(from), instant(to)];
  if (b <= a || b - a > maxDays * DAY) throw new Refusal(`from must be before to, at most ${maxDays} days apart.`);
  return [a, b] as const;
};
const attendees = (list: string[] = []) => list.map((address) => ({ type: "required", emailAddress: { address } }));

type Event = { id: string; subject?: string; start?: When; end?: When; location?: { displayName?: string }; organizer?: Address; isOnlineMeeting?: boolean; onlineMeeting?: { joinUrl?: string } | null; responseStatus?: { response?: string } };
const event = (e: Event) => ({
  id: e.id, subject: e.subject, start: at(e.start), end: at(e.end), location: e.location?.displayName || undefined, organizer: who(e.organizer),
  online: e.isOnlineMeeting || undefined, joinUrl: e.onlineMeeting?.joinUrl, response: e.responseStatus?.response,
});

type DriveItem = { id: string; name: string; size?: number; webUrl?: string; lastModifiedDateTime?: string; folder?: unknown; file?: { mimeType?: string }; "@microsoft.graph.downloadUrl"?: string };
const FILE_FIELDS = "id,name,size,webUrl,lastModifiedDateTime,folder";
const item = (f: DriveItem) => ({ id: f.id, name: f.name, size: f.size, modified: f.lastModifiedDateTime, webUrl: f.webUrl, ...(f.folder ? { folder: true } : {}) });
const TEXT_TYPE = /^(text\/|application\/(json|xml|csv|x-yaml|yaml|javascript|x-sh)\b)/;
const TEXT_NAME = /\.(txt|md|csv|tsv|json|xml|html?|log|ya?ml|ini|sql|js|ts|py|sh)$/i;
const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp)$/;
const MAX_IMAGE = 3_750_000; // bytes: the model's limit for one image
const MAX_ATTACHMENT = 10 * 1024 * 1024;
type Attachment = { "@odata.type"?: string; id: string; name?: string; contentType?: string; size?: number; isInline?: boolean; contentBytes?: string };
const attachment = (a: Attachment) => ({ id: a.id, name: a.name, type: a.contentType, size: a.size, ...(a.isInline ? { inline: true } : {}) });

// shortcut: strips tags and &nbsp; only, other entities stay encoded; decode them if the model trips over them
const plain = (html?: string) => html?.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, PREVIEW);
type ChatFrom = { user?: { displayName?: string }; application?: { displayName?: string } } | null;
const sender = (f?: ChatFrom) => f?.user?.displayName ?? f?.application?.displayName;

const top = (max: number) => z.number().int().min(1).max(max).optional();
const times = "ISO 8601 date and time with an offset, e.g. 2026-11-02T09:00:00Z";

/** Microsoft 365 as the person talking, through Graph with their delegated token; only the tools of the given capabilities. */
export function m365McpServer(deps: { fetchFn: typeof fetch; sleep?: GraphDeps["sleep"]; readDocument?: (pdfBase64: string) => Promise<string> }, ctx: Ctx, capabilities: readonly GraphCapability[]): McpSdkServerConfigWithInstance {
  const g: GraphDeps = { fetchFn: deps.fetchFn, token: () => ctx.graphToken(), ...(deps.sleep ? { sleep: deps.sleep } : {}) };
  const get = async <T>(path: string, headers?: Record<string, string>) => (await graphFetch(g, path, headers ? { headers } : {})).json() as Promise<T>;
  const post = async (path: string, json: unknown) => (await graphFetch(g, path, { method: "POST", json })).body?.cancel();
  const run = <A>(f: (a: A) => Promise<unknown>) => async (a: A) => {
    try {
      return ok(await f(a));
    } catch (e) {
      if (e instanceof GraphError && e.status === 401) ctx.signInLost?.();
      return fail(e);
    }
  };

  // the SDK's own element type for a list of tools with different schemas
  const tools: [GraphCapability, SdkMcpToolDefinition<any>][] = [
    ["mail.read", tool("search_mail", "Search the person's mailbox. Results have previews only; read_mail gives a body.", { query: z.string().min(1), top: top(25) }, run(async ({ query, top }) =>
      (await get<{ value: Message[] }>(`/me/messages?${qs({ $search: `"${query.replace(/"/g, "")}"`, $top: top ?? 10, $select: MAIL_FIELDS })}`)).value.map(mail)))],
    ["mail.read", tool("list_mail", "List the newest mail in the person's inbox or sent folder.", { folder: z.enum(["inbox", "sent"]).optional(), top: top(25) }, run(async ({ folder, top }) =>
      (await get<{ value: Message[] }>(`/me/mailFolders/${folder === "sent" ? "sentitems" : "inbox"}/messages?${qs({ $top: top ?? 10, $select: MAIL_FIELDS, $orderby: "receivedDateTime desc" })}`)).value.map(mail)))],
    ["mail.read", tool("read_mail", "Read one email with its body as text, and the list of its attachments.", { id: z.string().min(1) }, run(async ({ id }) => {
      const m = await get<Message>(`/me/messages/${idPart(id)}?${qs({ $select: "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments" })}`, { Prefer: 'outlook.body-content-type="text"' });
      const files = m.hasAttachments ? (await get<{ value: Attachment[] }>(`/me/messages/${idPart(id)}/attachments?${qs({ $select: "id,name,contentType,size,isInline" })}`)).value.map(attachment) : undefined;
      return { ...mail(m), preview: undefined, cc: m.ccRecipients?.map(who), body: m.body?.content?.slice(0, BODY), attachments: files };
    }))],
    ["mail.read", tool("read_attachment", "Read one attachment of an email (ids from read_mail): text, PDF and images; other kinds give their details only.", { id: z.string().min(1), attachmentId: z.string().min(1) }, run(async ({ id, attachmentId }) => {
      const a = await get<Attachment>(`/me/messages/${idPart(id)}/attachments/${idPart(attachmentId)}`);
      const details = attachment(a);
      const bytes = a["@odata.type"] === "#microsoft.graph.fileAttachment" && a.contentBytes ? Buffer.from(a.contentBytes, "base64") : undefined;
      if (!bytes) return { ...details, note: "an attached email or link, not a file" };
      if (bytes.length > MAX_ATTACHMENT) return { ...details, note: "too large to read" };
      const type = a.contentType ?? "";
      if (TEXT_TYPE.test(type) || TEXT_NAME.test(a.name ?? "")) return { ...details, text: bytes.toString("utf8").slice(0, BODY) };
      if (IMAGE_TYPE.test(type) && bytes.length <= MAX_IMAGE) return new Content([{ type: "image", data: a.contentBytes!, mimeType: type }]);
      if ((type === "application/pdf" || /\.pdf$/i.test(a.name ?? "")) && deps.readDocument) return { ...details, text: (await deps.readDocument(a.contentBytes!)).slice(0, BODY) };
      return { ...details, note: "not readable as text" };
    }))],
    ["mail.send", tool("send_mail", "Send an email as the person; they confirm it in the chat first.", { to: z.array(z.string()).min(1), cc: z.array(z.string()).optional(), subject: z.string(), body: z.string() }, run(async (a) => {
      await post("/me/sendMail", {
        message: { subject: a.subject, body: { contentType: "Text", content: a.body }, toRecipients: recipients(a.to), ...(a.cc?.length ? { ccRecipients: recipients(a.cc) } : {}) },
        saveToSentItems: true,
      });
      return "Sent.";
    }))],
    ["mail.send", tool("reply_mail", "Reply to an email as the person (all: reply to everyone); they confirm it in the chat first.", { id: z.string().min(1), body: z.string(), all: z.boolean().optional() }, run(async ({ id, body, all }) => {
      await post(`/me/messages/${idPart(id)}/${all ? "replyAll" : "reply"}`, { comment: body });
      return "Sent.";
    }))],
    ["calendar.read", tool("list_events", `List the person's calendar between from and to, at most 31 days apart (${times}). Times come back in UTC.`, { from: z.string(), to: z.string() }, run(async ({ from, to }) => {
      const [a, b] = span(from, to, 31);
      // shortcut: the first 100 events only, no paging; page if a month holds more
      const r = await get<{ value: Event[] }>(
        `/me/calendarView?${qs({ startDateTime: new Date(a).toISOString(), endDateTime: new Date(b).toISOString(), $top: 100, $orderby: "start/dateTime", $select: "id,subject,start,end,location,organizer,isOnlineMeeting,onlineMeeting,responseStatus" })}`,
        { Prefer: 'outlook.timezone="UTC"' },
      );
      return r.value.map(event);
    }))],
    ["calendar.read", tool("find_free_time", `Suggest meeting times of the given minutes when the person and the attendees are free, between from and to (${times}).`, { attendees: z.array(z.string()), from: z.string(), to: z.string(), minutes: z.number().int().min(5).max(480) }, run(async (a) => {
      const [from, to] = span(a.from, a.to, 31);
      const r = (await (await graphFetch(g, "/me/findMeetingTimes", {
        method: "POST",
        json: { attendees: attendees(a.attendees), timeConstraint: { activityDomain: "work", timeSlots: [{ start: utc(from), end: utc(to) }] }, meetingDuration: `PT${a.minutes}M`, maxCandidates: 10 },
      })).json()) as { meetingTimeSuggestions?: { confidence?: number; meetingTimeSlot?: { start?: When; end?: When } }[]; emptySuggestionsReason?: string };
      return { suggestions: (r.meetingTimeSuggestions ?? []).map((s) => ({ start: at(s.meetingTimeSlot?.start), end: at(s.meetingTimeSlot?.end), confidence: s.confidence })), reason: r.emptySuggestionsReason || undefined };
    }))],
    ["calendar.write", tool("create_event", `Put an event in the person's calendar and invite the attendees (online: a Teams meeting); they confirm it in the chat first. ${times}.`, { subject: z.string(), start: z.string(), end: z.string(), attendees: z.array(z.string()).optional(), online: z.boolean().optional(), body: z.string().optional() }, run(async (a) => {
      const [start, end] = span(a.start, a.end, 31);
      const e = (await (await graphFetch(g, "/me/events", {
        method: "POST",
        json: {
          subject: a.subject, start: utc(start), end: utc(end),
          ...(a.attendees?.length ? { attendees: attendees(a.attendees) } : {}),
          ...(a.online ? { isOnlineMeeting: true, onlineMeetingProvider: "teamsForBusiness" } : {}),
          ...(a.body ? { body: { contentType: "Text", content: a.body } } : {}),
        },
      })).json()) as Event;
      return event(e);
    }))],
    ["calendar.write", tool("respond_event", "Accept, decline or tentatively accept an invitation as the person; they confirm it in the chat first.", { id: z.string().min(1), response: z.enum(["accept", "decline", "tentative"]), comment: z.string().optional() }, run(async ({ id, response, comment }) => {
      await post(`/me/events/${idPart(id)}/${response === "tentative" ? "tentativelyAccept" : response}`, { ...(comment ? { comment } : {}), sendResponse: true });
      return "Done.";
    }))],
    ["files.read", tool("search_files", "Search the person's OneDrive and the files shared with them.", { query: z.string().min(1), top: top(25) }, run(async ({ query, top }) =>
      (await get<{ value: DriveItem[] }>(`/me/drive/root/search(q='${enc(query.replace(/'/g, "''"))}')?${qs({ $top: top ?? 10, $select: FILE_FIELDS })}`)).value.map(item)))],
    ["files.read", tool("read_file", "Read a file's text; other formats give its details only.", { id: z.string().min(1) }, run(async ({ id }) => {
      const f = await get<DriveItem>(`/me/drive/items/${idPart(id)}`);
      const url = f["@microsoft.graph.downloadUrl"];
      if (f.folder || !url || !(TEXT_TYPE.test(f.file?.mimeType ?? "") || TEXT_NAME.test(f.name))) return { ...item(f), note: "not readable as text" };
      // the download URL is pre-authenticated and outside Graph, so the token never goes there, and its 401 says nothing about the token
      const res = await deps.fetchFn(url, { headers: { Range: `bytes=0-${READ_LIMIT - 1}` } });
      if (!res.ok) {
        await res.body?.cancel();
        throw new Refusal(`Not done: the file could not be downloaded (${res.status}).`);
      }
      return { ...item(f), text: (await readCapped(res, READ_LIMIT)).slice(0, BODY) };
    }))],
    ["files.write", tool("upload_file", "Save a text file (at most 4 MB) in a folder of the person's OneDrive; an existing file of that name is kept and the new one renamed. They confirm it in the chat first.", { folder: z.string(), name: z.string().min(1), content: z.string() }, run(async ({ folder, name, content }) => {
      const parts = [...folder.split("/"), name].map((s) => s.trim()).filter(Boolean);
      if (name.includes("/") || parts.some((p) => p === "." || p === ".." || /[\\:]/.test(p))) throw new Refusal("Not done: name must be a file name and folder a path, without . or .. parts, \\ or :.");
      if (Buffer.byteLength(content) > MAX_UPLOAD) throw new Refusal("Not done: files over 4 MB cannot be saved.");
      const res = await graphFetch(g, `/me/drive/root:/${parts.map(enc).join("/")}:/content?@microsoft.graph.conflictBehavior=rename`, { method: "PUT", body: content, headers: { "Content-Type": "text/plain" } });
      return item((await res.json()) as DriveItem);
    }))],
    ["chats.read", tool("list_chats", "List the person's most recent Teams chats with their last message.", { top: top(25) }, run(async ({ top }) => {
      type Chat = { id: string; topic?: string | null; chatType?: string; lastMessagePreview?: { createdDateTime?: string; from?: ChatFrom; body?: { content?: string } } | null };
      const r = await get<{ value: Chat[] }>(`/me/chats?${qs({ $top: top ?? 10, $expand: "lastMessagePreview", $orderby: "lastMessagePreview/createdDateTime desc" })}`);
      return r.value.map((c) => {
        const l = c.lastMessagePreview;
        return { id: c.id, topic: c.topic ?? undefined, type: c.chatType, last: l ? { from: sender(l.from), date: l.createdDateTime, preview: plain(l.body?.content) } : undefined };
      });
    }))],
    ["chats.read", tool("read_chat", "Read the newest messages of one of the person's Teams chats, as short text.", { id: z.string().min(1), top: top(50) }, run(async ({ id, top }) => {
      type ChatMessage = { id: string; createdDateTime?: string; from?: ChatFrom; body?: { content?: string } };
      const r = await get<{ value: ChatMessage[] }>(`/me/chats/${idPart(id)}/messages?${qs({ $top: top ?? 20, $orderby: "createdDateTime desc" })}`);
      return r.value.map((m) => ({ id: m.id, from: sender(m.from), date: m.createdDateTime, text: plain(m.body?.content) }));
    }))],
  ];
  return createSdkMcpServer({ name: "m365", tools: tools.filter(([c]) => capabilities.includes(c)).map(([, t]) => t) });
}
