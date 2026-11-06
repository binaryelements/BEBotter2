import { z } from "zod";
import { resolveModel } from "../engine/providers.js";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  DEEPSEEK_API_KEY: z.string().optional(),
  DASHSCOPE_API_KEY: z.string().optional(),
  DEEPSEEK_BASE_URL: z.string().url().optional(),
  QWEN_BASE_URL: z.string().url().optional(),
  SECRETS_KEY: z
    .string()
    .transform((s) => Buffer.from(s, "base64"))
    .refine((b) => b.length === 32, "SECRETS_KEY must be 32 bytes"),
  BOT_NAME: z.string().default("BE Bot"),
  DEFAULT_MODEL: z.string().default("deepseek/deepseek-flash"),
  PUBLIC_URL: z
    .string()
    .refine((s) => s.startsWith("https://") && URL.canParse(s), "PUBLIC_URL must be an absolute https:// URL")
    .transform((s) => s.replace(/\/+$/, "")),
  ADMIN_EMAILS: z
    .string()
    .default("")
    .transform((s) => s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)),
  PORT: z.coerce.number().int().default(3978),
  clientId: z.string().min(1),
  tenantId: z.string().min(1),
  clientSecret: z.string().min(1),
  COMPUTER_IMAGE: z.string().default("bebotter2-computer"),
  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  FILES_DIR: z.string().default("/srv/files"),
  AGENTMAIL_URL: z.string().default("https://agentmail.a.sapautomate.com").transform((s) => s.replace(/\/+$/, "")),
  AGENTMAIL_ADMIN_KEY: z.string().optional(),
  GRAPH_OAUTH_CONNECTION: z.string().default("graph"),
});

export type ProviderConfig = { apiKey: string; baseUrl?: string };

export type Config = {
  databaseUrl: string;
  providers: Record<string, ProviderConfig>;
  secretsKey: Buffer;
  botName: string;
  defaultModel: string;
  publicUrl: string;
  adminEmails: string[];
  port: number;
  teams: { clientId: string; tenantId: string; clientSecret: string };
  computerImage: string;
  dockerSocket: string;
  filesDir: string;
  agentmail?: { url: string; adminKey: string };
  /** The Azure Bot OAuth connection that signs a person in to Microsoft Graph. */
  graphOAuthConnection: string;
};

export function loadConfig(env: Record<string, string | undefined>): Config {
  const e = schema.parse(env);
  const defaultModel = e.DEFAULT_MODEL;

  const providers: Record<string, ProviderConfig> = {
    ...(e.DEEPSEEK_API_KEY ? { deepseek: { apiKey: e.DEEPSEEK_API_KEY, ...(e.DEEPSEEK_BASE_URL ? { baseUrl: e.DEEPSEEK_BASE_URL } : {}) } } : {}),
    ...(e.DASHSCOPE_API_KEY ? { qwen: { apiKey: e.DASHSCOPE_API_KEY, ...(e.QWEN_BASE_URL ? { baseUrl: e.QWEN_BASE_URL } : {}) } } : {}),
  };

  if (!Object.keys(providers).length) throw new Error("DEEPSEEK_API_KEY or DASHSCOPE_API_KEY is required");
  const resolved = resolveModel(defaultModel);
  if (!resolved) throw new Error(`DEFAULT_MODEL ${defaultModel} is not a known provider/model`);
  if (!providers[resolved.provider.id]) throw new Error(`DEFAULT_MODEL ${defaultModel} needs ${resolved.provider.id.toUpperCase()}_API_KEY`);

  return {
    databaseUrl: e.DATABASE_URL,
    providers,
    secretsKey: e.SECRETS_KEY,
    botName: e.BOT_NAME,
    defaultModel,
    publicUrl: e.PUBLIC_URL,
    adminEmails: e.ADMIN_EMAILS,
    port: e.PORT,
    teams: { clientId: e.clientId, tenantId: e.tenantId, clientSecret: e.clientSecret },
    computerImage: e.COMPUTER_IMAGE,
    dockerSocket: e.DOCKER_SOCKET,
    filesDir: e.FILES_DIR,
    agentmail: e.AGENTMAIL_ADMIN_KEY ? { url: e.AGENTMAIL_URL, adminKey: e.AGENTMAIL_ADMIN_KEY } : undefined,
    graphOAuthConnection: e.GRAPH_OAUTH_CONNECTION,
  };
}
