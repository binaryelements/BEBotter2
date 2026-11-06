FROM node:24-bookworm-slim
# LibreOffice turns Office attachments into PDFs for the document reader
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client poppler-utils libreoffice-writer-nogui libreoffice-impress-nogui libreoffice-calc-nogui fonts-dejavu-core fonts-liberation2 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
# the bots' browser (src/engine/browser.ts): headless Chromium of the version its Playwright expects, and the libraries it needs
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN node "$(dirname "$(node -p "require.resolve('playwright-core/package.json', { paths: [require.resolve('@playwright/mcp')] })")")/cli.js" install --with-deps --no-shell chromium && rm -rf /var/lib/apt/lists/*
COPY tsconfig.json ./
COPY src ./src
COPY examples ./examples
RUN pnpm build
RUN npm install -g @modelcontextprotocol/server-filesystem@2.1.0 && mkdir -p /srv/files
ENV NODE_ENV=production
EXPOSE 3978
CMD ["node", "dist/main.js"]
