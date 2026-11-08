/** BE AgentMail's own explanation of a refusal: plain text, short, with anything that looks like a key removed. */
export function cleanDetail(raw: unknown): string | undefined {
  // FastAPI validation errors arrive as a list of {msg}
  const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map((d) => (typeof (d as { msg?: unknown })?.msg === "string" ? (d as { msg: string }).msg : "")).filter(Boolean).join("; ") : "";
  const out = text.replace(/\b(?:bam|amwh)_\S*/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
  return out || undefined;
}

export class MailError extends Error {
  constructor(message: string, readonly status?: number, readonly detail?: string) {
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
        signal: AbortSignal.timeout(3000),
      });
    } catch {
      throw new MailError(`BE AgentMail unreachable: ${method} ${path}`);
    }
    if (!res.ok) {
      let detail: string | undefined;
      try {
        const j = JSON.parse(await res.text()) as { detail?: unknown };
        detail = cleanDetail(j.detail);
      } catch {
        // no readable explanation
      }
      throw new MailError(`BE AgentMail ${method} ${path} failed with status ${res.status}`, res.status, detail);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }
  const str = (v: unknown, field: string): string => {
    if (typeof v !== "string" || !v) throw new MailError(`BE AgentMail response is missing ${field}`);
    return v;
  };
  const field = (r: unknown, name: string) => str((r as Record<string, unknown>)[name], name);
  const seg = encodeURIComponent;
  let domainCache: { value?: string; error?: Error; until: number } | undefined;

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
    /** Send an alert or other system email from an inbox the admin key can reach. */
    async sendMessage(input: { inboxId: string; to: string[]; subject: string; text: string }): Promise<void> {
      await call("POST", "/messages/send", { inbox_id: input.inboxId, to: input.to, subject: input.subject, body_text: input.text });
    },
    /** The inbox with this local part, or undefined. Looked up in the inbox list, which also tells who owns it. */
    async findInbox(localPart: string): Promise<{ id: string; address: string; ownerAgent: string | null } | undefined> {
      const r = await call("GET", "/inboxes");
      const want = localPart.toLowerCase();
      const hit = (Array.isArray(r) ? r : []).find((i: { address?: unknown }) => String(i.address ?? "").split("@")[0]?.toLowerCase() === want);
      return hit && { id: field(hit, "id"), address: field(hit, "address"), ownerAgent: typeof hit.owner_agent === "string" ? hit.owner_agent : null };
    },
    async inboxTaken(localPart: string): Promise<boolean> {
      return !!(await this.findInbox(localPart));
    },
    /** The domain inboxes live on, from the status page. */
    async mailDomain(): Promise<string> {
      if (domainCache && domainCache.until > Date.now()) {
        if (domainCache.error) throw domainCache.error;
        return domainCache.value!;
      }
      try {
        const value = field(await call("GET", "/status"), "mail_domain");
        domainCache = { value, until: Date.now() + 5 * 60_000 };
        return value;
      } catch (e) {
        domainCache = { error: e as Error, until: Date.now() + 60_000 };
        throw e;
      }
    },
    // send-as answers are free-form objects; the admin page shows their plain fields
    /** Verdict of the domain checks: BE AgentMail answers `ready`; anything but `ready: true` refuses. Failed checks (DMARC aside, it is only reported) give the reasons. */
    async checkSendAs(address: string): Promise<{ ok: boolean; reasons: string[] }> {
      const r = (await call("GET", `/send-as-check?address=${seg(address)}`)) as { ready?: unknown; checks?: unknown };
      const failed = (Array.isArray(r.checks) ? r.checks : []).filter((c: { ok?: unknown; name?: unknown }) => c.ok === false && !/dmarc/i.test(String(c.name ?? "")));
      const reasons = failed.map((c: { name?: unknown; detail?: unknown }) => cleanDetail(`${String(c.name ?? "")}: ${String(c.detail ?? "")}`)).filter((x): x is string => !!x);
      return { ok: r.ready === true && failed.length === 0, reasons };
    },
    async requestSendAs(inboxId: string, address: string): Promise<Record<string, unknown>> {
      return (await call("POST", `/inboxes/${seg(inboxId)}/send-as`, { address })) as Record<string, unknown>;
    },
    async getSendAs(inboxId: string): Promise<Record<string, unknown>> {
      return (await call("GET", `/inboxes/${seg(inboxId)}/send-as`)) as Record<string, unknown>;
    },
    async removeSendAs(inboxId: string): Promise<void> {
      await call("DELETE", `/inboxes/${seg(inboxId)}/send-as`);
    },
    /** Ids of the agent's keys that are not revoked. */
    async listKeys(agent: string): Promise<string[]> {
      const r = await call("GET", `/agents/${seg(agent)}/keys`);
      return (Array.isArray(r) ? r : []).filter((k: { revoked_at?: unknown }) => !k.revoked_at).map((k) => field(k, "id"));
    },
    async listWebhooks(agent: string): Promise<string[]> {
      const r = await call("GET", `/agents/${seg(agent)}/webhooks`);
      return (Array.isArray(r) ? r : []).map((w) => field(w, "id"));
    },
  };
}
