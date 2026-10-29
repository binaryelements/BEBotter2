export type Outcome = "confirmed" | "denied" | "expired";

type Pending = { askerPersonId: string; settle: (o: Outcome) => void };

/** In-memory by design: a restart expires every pending confirmation. */
export class Confirmations {
  private pending = new Map<string, Pending>();

  constructor(private schedule: (fn: () => void, ms: number) => unknown = setTimeout) {}

  create(opts: { auditId: string; askerPersonId: string; ttlMs?: number }): {
    actionId: string;
    outcome: Promise<Outcome>;
  } {
    const actionId = crypto.randomUUID();
    const outcome = new Promise<Outcome>((resolve) => {
      const settle = (o: Outcome) => {
        this.pending.delete(actionId);
        resolve(o);
      };
      this.pending.set(actionId, { askerPersonId: opts.askerPersonId, settle });
      this.schedule(() => settle("expired"), opts.ttlMs ?? 600_000);
    });
    return { actionId, outcome };
  }

  resolve(actionId: string, personId: string, answer: "yes" | "no"): "confirmed" | "denied" | "not_allowed" | "unknown" {
    const p = this.pending.get(actionId);
    if (!p) return "unknown";
    if (p.askerPersonId !== personId) return "not_allowed";
    const o = answer === "yes" ? "confirmed" : "denied";
    p.settle(o);
    return o;
  }
}
