import { createSdkMcpServer, tool } from "../engine/mcp.js";
import type { McpServerHandle } from "../engine/mcp.js";

/** When each group chat told its bot to stop listening, keyed chat:bot. shortcut: in memory, so a restart forgets it; the window is at most 30 minutes, store it if that ever matters. */
const stopped = new Map<string, number>();
export const stopListening = (chatId: string, definitionId: string, at = Date.now()): void => void stopped.set(`${chatId}:${definitionId}`, at);
export const stoppedAt = (chatId: string, definitionId: string): number => stopped.get(`${chatId}:${definitionId}`) ?? 0;

/** `stop_listening`: the bot decides a group chat has told it to butt out, in whatever words. */
export function listeningMcpServer(ctx: { chatId: string; definitionId: string }): McpServerHandle {
  return createSdkMcpServer({
    name: "listening",
    tools: [
      tool(
        "stop_listening",
        "In a group chat, after you answer someone you treat their next messages for a while as meant for you. Call this when someone makes clear they are done with you or want you out of the conversation " +
          "(\"ignore that request\", \"we've got it from here\", \"not your business\", \"you can butt out\"), so you stop treating their messages as follow-ups until someone names you again. " +
          "Do not call it for a request that merely contains the word stop, such as \"stop the backup job\". " +
          "When the newest message tells you to stop, ignore or drop it, do not act on or answer the earlier messages that came with it: call this and reply with one short acknowledgement.",
        {},
        async () => {
          stopListening(ctx.chatId, ctx.definitionId);
          return { content: [{ type: "text" as const, text: "Stopped listening; you answer again when someone names you." }] };
        },
      ),
    ],
  });
}
