# Deploying

Both apps deploy from the GitHub webhook. Nothing else should trigger them.

| Branch               | App              | URL                                  |
| -------------------- | ---------------- | ------------------------------------ |
| `deploy/coolify-test` | botter-staging   | https://botter-staging.binaryelements.com |
| `deploy/coolify-prod` | botter-production | https://teammate.binaryelements.com  |

Push the commit, then wait. The webhook queues the build for the branch it
watches, so a push to both branches builds staging and production once each.

**Do not also POST `/api/v1/deploy` for that commit.** The webhook has already
queued it; the second call answers "Deployment already queued for this commit"
and the duplicate waits in the queue behind the real build, which is most of why
a deploy that should take minutes can take tens of minutes.

## The admin console

The new React admin is a separate app with its own image (`console/Dockerfile`),
served under `/admin/console` on the same address. It deploys without restarting
the engine. Setup, watch paths and rules are in `console/README.md`.

## The base image

`Dockerfile` starts from `ghcr.io/binaryelements/bebotter2-base:1`, which holds
the parts that never change with the source: LibreOffice, the Playwright Chromium
build and the globally installed MCP servers. It is built by
`.github/workflows/base-image.yml` and only when `Dockerfile.base` changes, so an
ordinary deploy copies the source and runs `pnpm install` + `pnpm build` instead
of reinstalling a gigabyte of runtime.

After changing `Dockerfile.base`:

1. Push. The workflow publishes `bebotter2-base:<commit>` and retags `:1`.
2. Bump the tag in `Dockerfile` (`:1` -> `:2`). `docker build` reuses a local
   image with the same tag and only pulls a tag the host has never seen, so a
   rebuilt `:1` would not reach the host on its own.
3. Keep the `@playwright/mcp` version in `Dockerfile.base` equal to the one in
   `package.json`: the browser build must match the client that drives it.
