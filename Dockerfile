# The runtime is a published base image: LibreOffice, the headless Chromium the
# browser tools drive and the globally installed MCP servers live there, so a
# deploy copies the source and compiles it instead of reinstalling them.
# See Dockerfile.base and .github/workflows/base-image.yml.
FROM ghcr.io/binaryelements/bebotter2-base:1

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# the pnpm store is a cache mount, so a warm builder does not download the tree
# again and the store never ends up in the image
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY examples ./examples
RUN pnpm build
ENV NODE_ENV=production
EXPOSE 3978
CMD ["node", "dist/main.js"]
