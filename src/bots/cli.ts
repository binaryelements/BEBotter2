import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { and, eq } from "drizzle-orm";
import { loadConfig } from "../config/config.js";
import { loadEnvFile } from "../config/env-file.js";
import { connect } from "../db/client.js";
import { botDefinitions, chats } from "../db/schema.js";
import { agentMailAdmin } from "../mail/agentmail.js";
import { ensureMailbox } from "../mail/mailboxes.js";
import { assignToChat, botDefinitionInput, upsertDefinition } from "./definitions.js";

const usage = `Usage:
  pnpm bot-def upsert --tenant <id> --file def.json
  pnpm bot-def assign --chat <conversationId> --name <definitionName> --tenant <id>`;

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

  loadEnvFile();
  const config = loadConfig(process.env);
  const db = await connect(config.databaseUrl);

  if (command === "upsert") {
    if (!values.tenant || !values.file) throw new Error(usage);
    // An explicit DEFAULT_MODEL wins over the tenant default; otherwise upsertDefinition picks tenant, then built-in.
    const fallback = process.env.DEFAULT_MODEL ? { model: config.defaultModel } : {};
    const input = botDefinitionInput.parse({ ...fallback, ...JSON.parse(readFileSync(values.file, "utf8")) });
    const def = await upsertDefinition(db, config.secretsKey, values.tenant, input);
    console.log(def.id);
    if (config.agentmail) {
      const mail = { db, secretsKey: config.secretsKey, admin: agentMailAdmin(config.agentmail, fetch), publicUrl: config.publicUrl };
      // the save already succeeded; the service finishes a failed mailbox on its next start
      await ensureMailbox(mail, def.id).catch((e) => console.error("mailbox:", e instanceof Error ? e.name : "error"));
    }
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
