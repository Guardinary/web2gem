FROM node:26-alpine AS deps

WORKDIR /app
ARG PNPM_VERSION=11.10.0
RUN npm install -g pnpm@${PNPM_VERSION}

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build

COPY tsconfig.json vitest.config.mjs wrangler.jsonc ./
COPY scripts ./scripts
COPY server ./server
COPY src ./src
RUN pnpm build

FROM node:26-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=52389 \
    UPSTREAM_SOCKET=false

COPY --from=build /app/dist/worker.js ./dist/worker.js
COPY --from=build /app/server/docker-server.mjs ./server/docker-server.mjs
COPY --from=build /app/server/d1-http-binding.mjs ./server/d1-http-binding.mjs
COPY --from=build /app/server/io.mjs ./server/io.mjs

EXPOSE 52389
CMD ["node", "server/docker-server.mjs"]
