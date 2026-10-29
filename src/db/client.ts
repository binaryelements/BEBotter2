import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import { migrationsFolder } from "./migrations-folder.js";
import * as schema from "./schema.js";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export async function connect(databaseUrl: string): Promise<Db> {
  const db = drizzle(new pg.Pool({ connectionString: databaseUrl }), { schema });
  await migrate(db, { migrationsFolder: migrationsFolder() });
  return db;
}
