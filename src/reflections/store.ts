import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { learningProposals, learnings, people, reflections } from "../db/schema.js";
import type { LearningProposal, Reflection } from "../db/schema.js";
import { addLearning, deleteLearning, updateLearning } from "../learnings/store.js";
import { DirectoryError } from "../org/directory.js";

export type ReflectionMode = "off" | "propose" | "auto";
export type LearningAction = "add" | "update" | "remove";

export const reflectionModes: ReflectionMode[] = ["off", "propose", "auto"];

/** The local calendar day in the tenant's zone, as YYYY-MM-DD. */
export function dayInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The local hour (0-23) in the tenant's zone. */
export function hourInZone(date: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", hour: "2-digit" }).format(date));
}

export const reflectionKey = (tenantId: string, definitionId: string, ownerPersonId: string | null | undefined, day: string) =>
  `${tenantId}:${definitionId}:${ownerPersonId ?? ""}:${day}`;

export async function getReflection(db: Db, key: string): Promise<Reflection | undefined> {
  const [row] = await db.select().from(reflections).where(eq(reflections.key, key));
  return row;
}

export async function listReflections(db: Db, tenantId: string, definitionId: string, limit = 30): Promise<Reflection[]> {
  return db
    .select()
    .from(reflections)
    .where(and(eq(reflections.tenantId, tenantId), eq(reflections.definitionId, definitionId)))
    .orderBy(desc(reflections.day), desc(reflections.createdAt))
    .limit(limit);
}

export type ReflectionInput = {
  id?: string;
  tenantId: string;
  definitionId: string;
  ownerPersonId?: string | null;
  day: string;
  summary: string;
  wentWell?: string | null;
  wentWrong?: string | null;
  corrections?: string | null;
  willDo?: string | null;
  model?: string | null;
  costUsd?: number;
};

/** One reflection per bot (and owner) per day; a second run returns the first row. */
export async function saveReflection(db: Db, input: ReflectionInput): Promise<Reflection> {
  const key = reflectionKey(input.tenantId, input.definitionId, input.ownerPersonId, input.day);
  const [row] = await db
    .insert(reflections)
    .values({
      id: input.id ?? crypto.randomUUID(),
      key,
      tenantId: input.tenantId,
      definitionId: input.definitionId,
      ownerPersonId: input.ownerPersonId ?? null,
      day: input.day,
      summary: input.summary.slice(0, 8_000),
      wentWell: input.wentWell?.slice(0, 4_000) ?? null,
      wentWrong: input.wentWrong?.slice(0, 4_000) ?? null,
      corrections: input.corrections?.slice(0, 4_000) ?? null,
      willDo: input.willDo?.slice(0, 4_000) ?? null,
      model: input.model ?? null,
      costUsd: input.costUsd !== undefined ? input.costUsd.toString() : null,
    })
    .onConflictDoNothing({ target: reflections.key })
    .returning();
  return row ?? (await getReflection(db, key))!;
}

export type ProposalInput = {
  tenantId: string;
  definitionId: string;
  ownerPersonId?: string | null;
  reflectionId?: string | null;
  action: LearningAction;
  learningId?: string | null;
  text?: string | null;
  reason?: string | null;
};

export async function createProposal(db: Db, input: ProposalInput): Promise<LearningProposal> {
  const [row] = await db
    .insert(learningProposals)
    .values({
      id: crypto.randomUUID(),
      tenantId: input.tenantId,
      definitionId: input.definitionId,
      ownerPersonId: input.ownerPersonId ?? null,
      reflectionId: input.reflectionId ?? null,
      action: input.action,
      learningId: input.learningId ?? null,
      text: input.text?.slice(0, 1_000) ?? null,
      reason: input.reason?.slice(0, 1_000) ?? null,
    })
    .returning();
  return row!;
}

export async function listProposals(db: Db, tenantId: string, definitionId: string, status?: "pending" | "approved" | "rejected"): Promise<LearningProposal[]> {
  return db
    .select()
    .from(learningProposals)
    .where(and(eq(learningProposals.tenantId, tenantId), eq(learningProposals.definitionId, definitionId), status ? eq(learningProposals.status, status) : undefined))
    .orderBy(desc(learningProposals.createdAt));
}

/** The tenant's first admin, used as the author when an auto reflection writes a learning. */
async function firstAdmin(db: Db, tenantId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: people.id })
    .from(people)
    .where(and(eq(people.tenantId, tenantId), eq(people.role, "admin")))
    .orderBy(asc(people.createdAt))
    .limit(1);
  return row?.id;
}

/** A learning the reflection may change must belong to this bot and, on Personal, to this owner. */
async function ownedLearning(db: Db, tenantId: string, definitionId: string, ownerPersonId: string | null | undefined, id: string) {
  const [row] = await db
    .select()
    .from(learnings)
    .where(
      and(
        eq(learnings.id, id),
        eq(learnings.tenantId, tenantId),
        eq(learnings.definitionId, definitionId),
        ownerPersonId ? eq(learnings.ownerPersonId, ownerPersonId) : isNull(learnings.ownerPersonId),
      ),
    );
  if (!row) throw new DirectoryError("No such learning");
  return row;
}

export type ApplyInput = {
  tenantId: string;
  definitionId: string;
  ownerPersonId?: string | null;
  action: LearningAction;
  learningId?: string | null;
  text?: string | null;
  /** Who the learning is attributed to: the approving admin, or the tenant's first admin in auto mode. */
  personId: string;
  chatId?: string | null;
};

/** Apply one add/update/remove to the bot's learnings. */
export async function applyLearningAction(db: Db, input: ApplyInput): Promise<void> {
  if (input.action === "add") {
    const text = input.text?.trim();
    if (!text) throw new DirectoryError("A new learning needs text");
    await addLearning(db, input.tenantId, {
      definitionId: input.definitionId,
      text,
      taughtByPersonId: input.personId,
      ownerPersonId: input.ownerPersonId ?? null,
      chatId: input.chatId ?? null,
      source: "reflection",
    });
    return;
  }
  if (!input.learningId) throw new DirectoryError("That change needs a learning id");
  await ownedLearning(db, input.tenantId, input.definitionId, input.ownerPersonId, input.learningId);
  if (input.action === "update") {
    const text = input.text?.trim();
    if (!text) throw new DirectoryError("An updated learning needs text");
    await updateLearning(db, input.tenantId, input.definitionId, input.learningId, text);
    return;
  }
  await deleteLearning(db, input.tenantId, input.definitionId, input.learningId);
}

/** Approve or reject a pending proposal; approving applies it first. */
export async function decideProposal(
  db: Db,
  tenantId: string,
  definitionId: string,
  id: string,
  decision: "approved" | "rejected",
  personId: string,
): Promise<LearningProposal> {
  const [proposal] = await db
    .select()
    .from(learningProposals)
    .where(and(eq(learningProposals.id, id), eq(learningProposals.tenantId, tenantId), eq(learningProposals.definitionId, definitionId)));
  if (!proposal) throw new DirectoryError("No such proposal");
  if (proposal.status !== "pending") throw new DirectoryError("That proposal was already decided");
  if (decision === "approved") {
    await applyLearningAction(db, {
      tenantId,
      definitionId,
      ownerPersonId: proposal.ownerPersonId,
      action: proposal.action as LearningAction,
      learningId: proposal.learningId,
      text: proposal.text,
      personId,
    });
  }
  const [row] = await db
    .update(learningProposals)
    .set({ status: decision, decidedByPersonId: personId, decidedAt: new Date() })
    .where(eq(learningProposals.id, id))
    .returning();
  return row!;
}

/** The author for an auto reflection: the tenant's first admin, or undefined when the tenant has none. */
export const reflectionAuthor = firstAdmin;
