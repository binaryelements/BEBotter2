import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

// Runs from src/db (tsx, vitest) or dist/db (compiled); migrations live only in src.
export const migrationsFolder = [
  new URL("./migrations", import.meta.url),
  new URL("../../src/db/migrations", import.meta.url),
]
  .map((u) => fileURLToPath(u))
  .find((p) => existsSync(p))!;

export async function connect(databaseUrl: string): Promise<Db> {
  const db = drizzle(new pg.Pool({ connectionString: databaseUrl }), { schema });
  await migrate(db, { migrationsFolder });
  return db;
}
