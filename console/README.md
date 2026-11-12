# The admin console

The new admin: React pages (`ui/`) and the JSON API they call (`server/`), built
and deployed as its own app. It runs beside the current server-rendered admin
(`src/admin`) until every page has moved.

## Why it is separate

The engine (Teams, the bots, the current admin) is one process, so every admin
change used to restart the bots. The console is a second, small process. It
shares two things with the engine and nothing else:

- the database (it reads and writes the same tables), and
- the sign-in cookie: `bb_session` is set for the path `/admin`, the console is
  served under `/admin/console`, and both use the same `SECRETS_KEY`.

A change under `console/` deploys the console only. The Teams path and the
engine are not touched and do not restart.

| Path                         | Served by |
| ---------------------------- | --------- |
| `/admin/console/`            | console: the pages |
| `/admin/console/api/...`     | console: JSON, and `api/events` (server-sent events) |
| everything else, `/admin/...` included | engine |

Signing in and out stay with the engine (`/admin/auth/...`). A signed-out
console sends the browser to `/admin/auth/login?returnTo=/admin/console`.

## Rules

- **The engine owns the schema.** The console never runs migrations. A change
  that needs a new column deploys the engine first, then the console.
- **Changing data needs the session's token.** Every request that is not a GET
  must send it in the `X-CSRF` header (`/api/me` hands it to the page).
- **Import only what is safe to load here.** `server/` uses the engine's
  session, access and schema files. Do not import a module that pulls in the
  Teams or engine code (`src/audit` does, for one): query the table instead.
- Still in the engine, to be bridged when their pages move: the try-it chat and
  the sign-in of an OAuth MCP connection.

## Running it locally

```sh
pnpm exec tsc -p console && (cd console/ui && pnpm install && pnpm build)
DATABASE_URL=... SECRETS_KEY=... node dist-console/console/server/main.js   # :3979

cd console/ui && pnpm dev    # pages with hot reload, API proxied to :3979
```

`console/ui` is its own pnpm root (own lockfile), so the engine image never
installs React or Vite. Tests: `pnpm exec vitest run console/server/app.test.ts`.

## Deploying (Coolify)

A second application on the same server and repository:

| Setting        | Value |
| -------------- | ----- |
| Build pack     | Dockerfile, `console/Dockerfile`, base directory `/` |
| Domain         | `https://teammate.binaryelements.com/admin/console` |
| Port           | 3979 |
| Health check   | `/health` |
| Environment    | `DATABASE_URL` and `SECRETS_KEY`, the same values as the engine |
| Watch paths    | `console/**`, `src/admin/session.ts`, `src/admin/access.ts`, `src/admin/assets/**`, `src/db/schema.ts` |

The longer path wins at the proxy, so only `/admin/console` reaches this app.
The server answers with or without the path prefix stripped.

For the engine app to stop rebuilding on console changes, give it watch paths
too: `src/**`, `examples/**`, `Dockerfile`, `package.json`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, `tsconfig.json`. Until then a console commit rebuilds
both.
