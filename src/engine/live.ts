/**
 * The turns running in this process, for the admin's "Running now" box. Memory only: a restart ends every turn too.
 * shortcut: one process sees only its own turns; if production ever runs two copies, move this into the database.
 */
export type LiveTurn = {
  tenantId: string;
  chatId: string;
  definitionId: string;
  startedBy: string;
  startedAt: Date;
  /** the action it is on now, as the activity log names it */
  doing?: string;
  steps: number;
  /** a confirmation card is out and the turn waits on someone's click */
  waiting: boolean;
};

const turns = new Map<symbol, LiveTurn>();

/** Adds a turn and returns its entry, to update as it goes, and the call that removes it. */
export function trackTurn(t: Omit<LiveTurn, "steps" | "waiting" | "startedAt">): { live: LiveTurn; done: () => void } {
  const key = Symbol();
  const live: LiveTurn = { ...t, startedAt: new Date(), steps: 0, waiting: false };
  turns.set(key, live);
  return { live, done: () => void turns.delete(key) };
}

/** A tenant's running turns, oldest first. */
export const liveTurns = (tenantId: string): LiveTurn[] =>
  [...turns.values()].filter((t) => t.tenantId === tenantId).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
