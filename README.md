# BE Botter 2

A Microsoft Teams bot service on the Claude Agent SDK: bot definitions per tenant, assigned to chats, with a confirmation card before any write.

1. `cp .env.example .env` and fill it in.
2. `docker build -f computer.Dockerfile -t bebotter2-computer .` (the sandbox image for bots with `computer: true`).
3. `docker compose up -d --build` (serves `/api/messages` and `/health` on port 3978).
4. `docker compose exec app pnpm bot-def upsert --tenant <tenantId> --file examples/it-support.json`
5. Message the bot in the chat; the service logs `chat <id> (<type>)` for every message (`docker compose logs app`).
6. `docker compose exec app pnpm bot-def assign --tenant <tenantId> --chat <id> --name it-support`

The admin page is at `/admin`; set `PUBLIC_URL` and `ADMIN_EMAILS` in `.env`.
The Entra app registration needs the Web redirect URI `<PUBLIC_URL>/admin/auth/callback`.

stdio MCP servers run inside the service container, so install them in the image (the IT Support example's filesystem server is in the Dockerfile).
