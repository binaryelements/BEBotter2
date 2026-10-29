import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  SECRETS_KEY: z
    .string()
    .transform((s) => Buffer.from(s, "base64"))
    .refine((b) => b.length === 32, "SECRETS_KEY must be 32 bytes"),
  BOT_NAME: z.string().default("BE Bot"),
  DEFAULT_MODEL: z.string().default("claude-haiku-5-5"),
  PORT: z.coerce.number().int().default(3978),
  clientId: z.string().min(1),
  tenantId: z.string().min(1),
  clientSecret: z.string().min(1),
  COMPUTER_IMAGE: z.string().default("bebotter2-computer"),
  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
});

export type Config = {
  databaseUrl: string;
  anthropicApiKey: string;
  secretsKey: Buffer;
  botName: string;
  defaultModel: string;
  port: number;
  teams: { clientId: string; tenantId: string; clientSecret: string };
  computerImage: string;
  dockerSocket: string;
};

export function loadConfig(env: Record<string, string | undefined>): Config {
  const e = schema.parse(env);
  return {
    databaseUrl: e.DATABASE_URL,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    secretsKey: e.SECRETS_KEY,
    botName: e.BOT_NAME,
    defaultModel: e.DEFAULT_MODEL,
    port: e.PORT,
    teams: { clientId: e.clientId, tenantId: e.tenantId, clientSecret: e.clientSecret },
    computerImage: e.COMPUTER_IMAGE,
    dockerSocket: e.DOCKER_SOCKET,
  };
}
