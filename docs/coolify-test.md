# Coolify test deploy

Branch `deploy/coolify-test`, based on the cutover: the OpenAI-compatible engine only. The Claude
Agent SDK, `ClaudeEngine`, `live.ts` and the `ENGINE` flag are gone.

## Environment

Set one provider in the Coolify app (the names are in `.env.example`):

- `DEEPSEEK_API_KEY=...` and `DEFAULT_MODEL=deepseek/deepseek-flash`, or
- `DASHSCOPE_API_KEY=...` and `DEFAULT_MODEL=qwen/qwen3.8-flash`.

Keep the existing values: `DATABASE_URL`, `SECRETS_KEY`, `PUBLIC_URL`, `clientId`, `tenantId`,
`clientSecret`, `ADMIN_EMAILS`, `COMPUTER_IMAGE`, `DOCKER_SOCKET`, `FILES_DIR`, `AGENTMAIL_*`.

`ANTHROPIC_API_KEY` and `ENGINE` are no longer read; leave them set or remove them.

The app runs Drizzle migrations at startup, including `0018` (`sessions.messages`, `summary`,
`input_tokens`, `output_tokens`, `provider`, `model`). There is no manual migration step, but the
Coolify Postgres must be reachable before the app starts.

If Coolify uses `compose.yaml`, its `env_file: .env` must resolve (create the file or inject the same
variables). If it builds the Dockerfile directly, Coolify's environment is enough.

## Smoke checklist

1. Deploy and watch the first logs; `/health` returns `{"ok":true}`.
2. Message a bot in Teams: a text answer.
3. Ask for a write tool (a connection or knowledge write): the confirmation card appears, approve,
   and the audit Activity row is `done`.
4. Send a second message: the transcript replays and the bot remembers the first.
5. Send a PDF attachment: `pdftotext` extracts it (poppler-utils is in the image).
6. A `webSearch` bot: the browser starts; a second turn reuses the pooled browser process.
7. Check the admin Activity/Overview: cost is reported from the provider profile.

## Rollback

There is no `ENGINE` flag after the cutover. Roll back by redeploying the previous image/branch;
`feat/engine-gaps` still has the Claude engine and the flag. Keep the previous deployment until the
smoke checks pass.
