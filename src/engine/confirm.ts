export type Outcome = { result: "confirmed"; personId: string } | { result: "denied" | "expired" };

type Pending = { chatId?: string; personId?: string; definitionId?: string; mayConfirm: (personId: string) => Promise<boolean>; settle: (o: Outcome) => void };

/** In-memory by design: a restart expires every pending confirmation. */
export class Confirmations {
  private pending = new Map<string, Pending>();
  // Teams delivers a click twice now and then; the second must not turn "Confirmed by" into "expired"
  private settled = new Map<string, "confirmed" | "denied">();

  constructor(private schedule: (fn: () => void, ms: number) => unknown = setTimeout) {}

  create(opts: { auditId: string; mayConfirm: (personId: string) => Promise<boolean>; ttlMs?: number; chatId?: string; personId?: string; definitionId?: string }): {
    actionId: string;
    outcome: Promise<Outcome>;
  } {
    const actionId = crypto.randomUUID();
    const outcome = new Promise<Outcome>((resolve) => {
      const settle = (o: Outcome) => {
        this.pending.delete(actionId);
        if (o.result !== "expired") {
          this.settled.set(actionId, o.result);
          (this.schedule(() => this.settled.delete(actionId), opts.ttlMs ?? 600_000) as { unref?: () => void } | undefined)?.unref?.();
        }
        resolve(o);
      };
      this.pending.set(actionId, { chatId: opts.chatId, personId: opts.personId, definitionId: opts.definitionId, mayConfirm: opts.mayConfirm, settle });
      const timer = this.schedule(() => settle({ result: "expired" }), opts.ttlMs ?? 600_000);
      (timer as { unref?: () => void } | undefined)?.unref?.(); // a pending timer must not hold the process open
    });
    return { actionId, outcome };
  }

  /** Stops waiting for these cards: a turn that has been superseded must not act when a late click arrives. */
  cancel(actionIds: Iterable<string>): void {
    for (const id of actionIds) {
      const p = this.pending.get(id);
      if (p) p.settle({ result: "expired" });
    }
  }

  /** The confirmation waiting in this chat for this person, if one is. */
  pendingFor(chatId: string, personId: string, definitionId?: string): string | undefined {
    for (const [id, p] of this.pending) if (p.chatId === chatId && p.personId === personId && (!definitionId || !p.definitionId || p.definitionId === definitionId)) return id;
    return undefined;
  }

  /** A typed yes/no, for people who answer the card in words instead of tapping it. */
  async resolveText(chatId: string, personId: string, answer: "yes" | "no", definitionId?: string): Promise<"confirmed" | "denied" | "not_allowed" | "unknown"> {
    const actionId = this.pendingFor(chatId, personId, definitionId);
    return actionId ? this.resolve(actionId, personId, answer) : "unknown";
  }

  async resolve(actionId: string, personId: string, answer: "yes" | "no"): Promise<"confirmed" | "denied" | "not_allowed" | "unknown"> {
    const p = this.pending.get(actionId);
    if (!p) return this.settled.get(actionId) ?? "unknown";
    if (!(await p.mayConfirm(personId).catch(() => false))) return "not_allowed";
    if (this.pending.get(actionId) !== p) return this.settled.get(actionId) ?? "unknown"; // settled while the policy was being checked
    p.settle(answer === "yes" ? { result: "confirmed", personId } : { result: "denied" });
    return answer === "yes" ? "confirmed" : "denied";
  }
}
