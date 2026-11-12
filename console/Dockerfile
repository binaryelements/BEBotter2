# The admin console: the React pages and their JSON API, as its own small image.
# It needs none of the engine's runtime (LibreOffice, Chromium, MCP servers), so it starts from plain Node.
# Build from the repository root:  docker build -f console/Dockerfile .
FROM node:24-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate
WORKDIR /app

# the pages
COPY console/ui/package.json console/ui/pnpm-lock.yaml console/ui/pnpm-workspace.yaml console/ui/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store cd console/ui && pnpm install --frozen-lockfile
# the stylesheets and logos are the current admin's own files, so both look the same
COPY src/admin/assets src/admin/assets
COPY console/ui console/ui
RUN cd console/ui && pnpm build

# the server: it compiles the few engine files it shares (session, access, schema) along with its own
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
# no install scripts: nothing the console runs needs a native build
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --ignore-scripts
COPY src src
COPY console/server console/server
COPY console/tsconfig.json console/tsconfig.json
RUN pnpm exec tsc -p console

FROM node:24-bookworm-slim
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# shortcut: this installs every engine package although the console loads four (express, drizzle-orm, pg, zod); give the console its own package.json if the image size starts to matter
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --prod --ignore-scripts
COPY --from=build /app/dist-console dist-console
COPY --from=build /app/console/ui/dist console/ui/dist
USER node
EXPOSE 3979
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3979)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist-console/console/server/main.js"]
