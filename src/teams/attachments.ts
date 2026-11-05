import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { and, desc, eq, gt, lt } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { chatAttachments } from "../db/schema.js";
import { MAX_ATTACHMENT, readBytes, sniffImage } from "../engine/read-document.js";

/** A file or image that came with a Teams message; `download` fetches it once, with the bot's own token where Teams needs one. */
export type IncomingAttachment = { name: string; mediaType: string; download: () => Promise<Buffer> };
export type Posted = { id: string; name: string; senderName: string; mediaType: string; at: Date };

/** How far back "what was posted" reaches when a turn starts. */
export const RECENT_MS = 10 * 60_000;
const FILE_INFO = "application/vnd.microsoft.teams.file.download.info";
const EXT_TYPE: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", txt: "text/plain", csv: "text/csv", md: "text/markdown" };

type Activity = { attachments?: { contentType?: string; contentUrl?: string; name?: string; content?: unknown }[] };
/**
 * The files and images on a Teams message. An inline image's URL is on the Teams service and wants the bot's token;
 * a file (Teams uploads, OneDrive and SharePoint shares) brings a download link of its own. Cards and the HTML copy of the text are not files.
 */
export function incomingAttachments(activity: Activity, fetchFn: typeof fetch, botToken: () => Promise<string>): IncomingAttachment[] {
  // the Teams service now and then sits on a download for the whole timeout, then serves it at once on the next try
  const fetchBytes = async (url: string, token?: string, retry = true): Promise<Buffer> => {
    const started = Date.now();
    const r = await fetchFn(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(30_000) })
      .catch((e: Error) => {
        if (retry && e.name === "TimeoutError") {
          console.error(`attachment download from ${new URL(url).host} timed out, retrying`);
          return undefined;
        }
        throw new Error(`${e.message} (${new URL(url).host})`);
      });
    if (!r) return fetchBytes(url, token, false);
    if (!r.ok) throw new Error(`attachment download ${r.status} from ${new URL(url).host}`);
    const bytes = Buffer.from(await r.arrayBuffer());
    console.log(`attachment downloaded: ${bytes.length} bytes in ${Date.now() - started} ms`);
    return bytes;
  };
  const out: IncomingAttachment[] = [];
  const shapes = (activity.attachments ?? []).filter((a) => a.contentType !== "text/html").map((a) => `${a.contentType} ${a.contentUrl ? new URL(a.contentUrl).host : "-"}`);
  if (shapes.length) console.log(`teams attachments: ${shapes.join(", ")}`);
  for (const a of activity.attachments ?? []) {
    const type = a.contentType ?? "";
    if (type.startsWith("image/") && a.contentUrl) {
      const url = a.contentUrl;
      // Teams says only "image/*" for a pasted picture; the real type and extension come from the bytes once downloaded
      out.push({ name: a.name || "image", mediaType: type, download: async () => fetchBytes(url, await botToken()) });
    } else if (type === FILE_INFO && typeof (a.content as { downloadUrl?: unknown })?.downloadUrl === "string") {
      const { downloadUrl: url, fileType } = a.content as { downloadUrl: string; fileType?: string };
      const ext = (fileType ?? a.name?.split(".").pop() ?? "").toLowerCase();
      out.push({ name: a.name || `file.${ext}`, mediaType: EXT_TYPE[ext] ?? "application/octet-stream", download: () => fetchBytes(url) });
    }
  }
  return out;
}

/** Downloads and keeps what came with a message; one that can't be fetched or is too big is logged and skipped. */
export async function storeAttachments(db: Db, m: { tenantId: string; chatId: string; personId?: string; senderName: string; at?: Date }, items: IncomingAttachment[]): Promise<Posted[]> {
  const posted: Posted[] = [];
  for (const a of items) {
    const bytes = await a.download().catch((e: Error) => (console.error(`attachment ${a.name} not downloaded: ${e.message}`), undefined));
    if (!bytes || bytes.length > MAX_ATTACHMENT) {
      if (bytes) console.error(`attachment ${a.name} skipped: ${bytes.length} bytes`);
      continue;
    }
    const sniffed = sniffImage(bytes);
    const mediaType = sniffed ?? a.mediaType;
    const name = sniffed && !/\.\w+$/.test(a.name) ? `${a.name}.${sniffed.slice(6).replace("jpeg", "jpg")}` : a.name;
    const row = { id: crypto.randomUUID(), tenantId: m.tenantId, chatId: m.chatId, personId: m.personId ?? null, name, senderName: m.senderName, mediaType, bytes, at: m.at ?? new Date() };
    await db.insert(chatAttachments).values(row);
    posted.push({ id: row.id, name: row.name, senderName: row.senderName, mediaType: row.mediaType, at: row.at });
  }
  return posted;
}

/** What was posted in the chat lately, newest first, so a turn can refer back to it. */
export async function recentAttachments(db: Db, chatId: string, now = new Date()): Promise<Posted[]> {
  return db.select({ id: chatAttachments.id, name: chatAttachments.name, senderName: chatAttachments.senderName, mediaType: chatAttachments.mediaType, at: chatAttachments.at })
    .from(chatAttachments).where(and(eq(chatAttachments.chatId, chatId), gt(chatAttachments.at, new Date(now.getTime() - RECENT_MS)))).orderBy(desc(chatAttachments.at)).limit(20);
}

const ago = (at: Date, now: Date) => {
  const m = Math.round((now.getTime() - at.getTime()) / 60_000);
  return m < 1 ? "with this message" : `${m} min ago`;
};
/** Prefixes the message with the files and images at hand, by id, so the bot opens the one that matters instead of guessing. */
export const withAttachments = (posted: Posted[], text: string, now = new Date()): string =>
  posted.length
    ? `[Files and images posted in this chat, newest first; open one with read_attachment and its id when it matters:\n${posted.map((p) => `- ${p.name} (${p.mediaType}, id ${p.id}) from ${p.senderName}, ${ago(p.at, now)}`).join("\n")}]\n\n${text}`
    : text;

export async function pruneAttachments(db: Db, tenantId: string, retentionDays: number, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
  return (await db.delete(chatAttachments).where(and(eq(chatAttachments.tenantId, tenantId), lt(chatAttachments.at, cutoff))).returning({ id: chatAttachments.id })).length;
}

/** The bot opens a file or image posted in the chat it is in: an image as itself, a document as text. */
export function attachmentsMcpServer(deps: { db: Db; readDocument?: (fileBase64: string, name: string) => Promise<string> }, ctx: { chatId: string }): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "attachments",
    tools: [
      tool("read_attachment", "Open a file or image posted in this chat (ids are listed at the start of the message): text, PDF, Word, PowerPoint, Excel and images; other kinds give their details only.", { id: z.string().min(1) }, async ({ id }) => {
        try {
          const [a] = await deps.db.select().from(chatAttachments).where(and(eq(chatAttachments.id, id), eq(chatAttachments.chatId, ctx.chatId)));
          if (!a) return { isError: true, content: [{ type: "text" as const, text: "No such attachment in this chat." }] };
          const read = await readBytes(Buffer.from(a.bytes), a.name, a.mediaType, deps.readDocument); // a bytea comes back as a bare byte array from some drivers
          if ("image" in read) return { content: [{ type: "image" as const, ...read.image }] };
          return { content: [{ type: "text" as const, text: JSON.stringify({ name: a.name, type: a.mediaType, from: a.senderName, ...read }) }] };
        } catch (e) {
          console.error("attachment tool failed", e instanceof Error ? e.message : e);
          return { isError: true, content: [{ type: "text" as const, text: "The attachment could not be read." }] };
        }
      }),
    ],
  });
}
