import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Migrations sit next to this module: in src/db, and copied to dist/db by `pnpm build`.
export function migrationsFolder(): string {
  const path = fileURLToPath(new URL("./migrations/", import.meta.url));
  if (!existsSync(path)) throw new Error(`Migrations folder not found: ${path}`);
  return path;
}
