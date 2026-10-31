export class MailError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "MailError";
  }
}

/** Admin client for BE AgentMail's REST API. Errors carry the status and path, never a key or a response body. */
export function agentMailAdmin(cfg: { url: string; adminKey: string }, fetchFn: typeof fetch) {
  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchFn(`${cfg.url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${cfg.adminKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new MailError(`BE AgentMail unreachable: ${method} ${path}`);
    }
    if (!res.ok) throw new MailError(`BE AgentMail ${method} ${path} failed with status ${res.status}`, res.status);
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }
  const str = (v: unknown, field: string): string => {
    if (typeof v !== "string" || !v) throw new MailError(`BE AgentMail response is missing ${field}`);
    return v;
  };
  const field = (r: unknown, name: string) => str((r as Record<string, unknown>)[name], name);
  const seg = encodeURIComponent;

  return {
    async createInbox(localPart: string, displayName: string, agent: string): Promise<{ id: string; address: string }> {
      const r = await call("POST", "/inboxes", { local_part: localPart, display_name: displayName, owner_agent: agent });
      return { id: field(r, "id"), address: field(r, "address") };
    },
    async setInboxActive(id: string, active: boolean): Promise<void> {
      await call("PATCH", `/inboxes/${seg(id)}`, { active });
    },
    async setDisplayName(id: string, name: string): Promise<void> {
      await call("PATCH", `/inboxes/${seg(id)}`, { display_name: name });
    },
    async issueKey(agent: string, label: string): Promise<{ id: string; key: string }> {
      const r = await call("POST", `/agents/${seg(agent)}/keys`, { label });
      return { id: field(r, "id"), key: field(r, "key") };
    },
    async revokeKey(id: string): Promise<void> {
      await call("DELETE", `/agent-keys/${seg(id)}`);
    },
    async addWebhook(agent: string, url: string, inboxId: string): Promise<{ id: string; secret: string }> {
      const r = await call("POST", `/agents/${seg(agent)}/webhooks`, { url, inbox: inboxId, events: ["message.received"] });
      return { id: field(r, "id"), secret: field(r, "signing_secret") };
    },
    async removeWebhook(id: string): Promise<void> {
      await call("DELETE", `/webhooks/${seg(id)}`);
    },
    async inboxTaken(localPart: string): Promise<boolean> {
      const r = await call("GET", "/inboxes");
      const want = localPart.toLowerCase();
      return Array.isArray(r) && r.some((i) => String((i as { address?: unknown }).address ?? "").split("@")[0]?.toLowerCase() === want);
    },
  };
}
