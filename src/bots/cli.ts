import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { and, eq } from "drizzle-orm";
import { loadConfig } from "../config/config.js";
import { connect } from "../db/client.js";
import { botDefinitions, chats } from "../db/schema.js";
import { assignToChat, botDefinitionInput, upsertDefinition } from "./definitions.js";

const usage = `Usage:
  pnpm bot-def upsert --tenant <id> --file def.json
  pnpm bot-def assign --chat <conversationId> --name <definitionName> --tenant <id>`;

// Minimal .env reader: existing environment values win.
function loadDotEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      tenant: { type: "string" },
      file: { type: "string" },
      chat: { type: "string" },
      name: { type: "string" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) return void console.log(usage);

  loadDotEnv();
  const config = loadConfig(process.env);
  const db = await connect(config.databaseUrl);

  if (command === "upsert") {
    if (!values.tenant || !values.file) throw new Error(usage);
    const input = botDefinitionInput.parse(JSON.parse(readFileSync(values.file, "utf8")));
    console.log((await upsertDefinition(db, config.secretsKey, values.tenant, input)).id);
  } else if (command === "assign") {
    if (!values.tenant || !values.chat || !values.name) throw new Error(usage);
    const [def] = await db
      .select()
      .from(botDefinitions)
      .where(and(eq(botDefinitions.tenantId, values.tenant), eq(botDefinitions.name, values.name)));
    if (!def) throw new Error(`No definition "${values.name}" for tenant ${values.tenant}`);
    const [chat] = await db.select().from(chats).where(eq(chats.id, values.chat));
    if (!chat || chat.tenantId !== values.tenant) throw new Error(`No chat ${values.chat} for tenant ${values.tenant}; it is created when the first message arrives`);
    await assignToChat(db, chat.id, def.id);
    console.log(def.id);
  } else {
    throw new Error(usage);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
