FROM node:24-alpine AS deps
WORKDIR /app
RUN npm install -g pnpm@10.17.0

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/server/package.json packages/server/package.json
RUN pnpm install --frozen-lockfile --filter @obsidian-rss-nas/server...

FROM deps AS build
COPY packages/server/tsconfig.json packages/server/tsconfig.json
COPY packages/server/src packages/server/src
RUN pnpm --filter @obsidian-rss-nas/server build

FROM build AS deploy
RUN pnpm --filter @obsidian-rss-nas/server deploy --prod --legacy /prod/server

FROM node:24-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache curl
COPY --from=deploy /prod/server ./

ENV HOST=0.0.0.0
ENV PORT=43112
ENV RSS_SERVER_DATA_FILE=/data/rss-state.json

EXPOSE 43112
VOLUME ["/data"]

CMD ["node", "dist/server.js"]
