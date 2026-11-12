import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { z } from "zod";
import * as schema from "../../src/db/schema.js";
import { consoleApp } from "./app.js";

// Only what the console needs. The engine owns the schema: this process never runs migrations, so deploy schema changes with the engine first.
const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    SECRETS_KEY: z
      .string()
      .transform((s) => Buffer.from(s, "base64"))
      .refine((b) => b.length === 32, "SECRETS_KEY must be 32 bytes"),
    PORT: z.coerce.number().default(3979),
  })
  .parse(process.env);

const db = drizzle(new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 }), { schema });
const uiDir = fileURLToPath(new URL("../../../console/ui/dist", import.meta.url));
const server = consoleApp({ db, secretsKey: env.SECRETS_KEY, uiDir }).listen(env.PORT, () => console.log(`console listening on ${env.PORT}`));
// open event streams would hold a deploy's old container up until it is killed
process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
