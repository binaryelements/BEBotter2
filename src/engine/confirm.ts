export type Outcome = { result: "confirmed"; personId: string } | { result: "denied" | "expired" };

type Pending = { mayConfirm: (personId: string) => Promise<boolean>; settle: (o: Outcome) => void };

/** In-memory by design: a restart expires every pending confirmation. */
export class Confirmations {
  private pending = new Map<string, Pending>();

  constructor(private schedule: (fn: () => void, ms: number) => unknown = setTimeout) {}

  create(opts: { auditId: string; mayConfirm: (personId: string) => Promise<boolean>; ttlMs?: number }): {
    actionId: string;
    outcome: Promise<Outcome>;
  } {
    const actionId = crypto.randomUUID();
    const outcome = new Promise<Outcome>((resolve) => {
      const settle = (o: Outcome) => {
        this.pending.delete(actionId);
        resolve(o);
      };
      this.pending.set(actionId, { mayConfirm: opts.mayConfirm, settle });
      const timer = this.schedule(() => settle({ result: "expired" }), opts.ttlMs ?? 600_000);
      (timer as { unref?: () => void } | undefined)?.unref?.(); // a pending timer must not hold the process open
    });
    return { actionId, outcome };
  }

  async resolve(actionId: string, personId: string, answer: "yes" | "no"): Promise<"confirmed" | "denied" | "not_allowed" | "unknown"> {
    const p = this.pending.get(actionId);
    if (!p) return "unknown";
    if (!(await p.mayConfirm(personId).catch(() => false))) return "not_allowed";
    if (this.pending.get(actionId) !== p) return "unknown"; // settled while the policy was being checked
    p.settle(answer === "yes" ? { result: "confirmed", personId } : { result: "denied" });
    return answer === "yes" ? "confirmed" : "denied";
  }
}
