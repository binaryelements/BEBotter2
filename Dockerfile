FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY examples ./examples
RUN pnpm build
RUN npm install -g @modelcontextprotocol/server-filesystem@2.1.0 && mkdir -p /srv/files
EXPOSE 3978
CMD ["node", "dist/main.js"]
