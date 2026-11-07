import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../db/client.js";
import { testDb } from "../db/test-db.js";
import { upsertPerson, upsertTenant } from "../org/org.js";
import { addTodo, completeTodo, countOpenTodos, deleteTodo, listTodos, updateTodo } from "./store.js";

describe("todos", () => {
  let db: Db;
  let ann: string;
  let bob: string;

  beforeAll(async () => {
    db = await testDb();
    await upsertTenant(db, { id: "t1" });
    ann = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "u1", name: "Ann" })).id;
    bob = (await upsertPerson(db, { tenantId: "t1", aadObjectId: "u2", name: "Bob" })).id;
  });

  it("adds, lists, completes and deletes an owner's to-dos", async () => {
    const a = await addTodo(db, { tenantId: "t1", personId: ann, title: "Send the report", dueAt: "2026-11-10" });
    expect(a.status).toBe("open");
    expect((await listTodos(db, "t1", ann)).map((t) => t.title)).toContain("Send the report");
    expect((await completeTodo(db, "t1", ann, a.id))?.status).toBe("done");
    expect((await completeTodo(db, "t1", ann, a.id, false))?.status).toBe("open");
    expect((await updateTodo(db, "t1", ann, a.id, { title: "Send the October report" }))?.title).toBe("Send the October report");
    expect(await countOpenTodos(db, "t1", [ann])).toEqual(new Map([[ann, 1]]));
    await deleteTodo(db, "t1", ann, a.id);
    expect(await listTodos(db, "t1", ann)).toEqual([]);
  });

  it("never touches another person's to-do", async () => {
    const a = await addTodo(db, { tenantId: "t1", personId: ann, title: "Mine" });
    expect(await completeTodo(db, "t1", bob, a.id)).toBeUndefined();
    expect(await updateTodo(db, "t1", bob, a.id, { title: "Theirs" })).toBeUndefined();
    expect((await listTodos(db, "t1", bob)).map((t) => t.id)).not.toContain(a.id);
  });
});
