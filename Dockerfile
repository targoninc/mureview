FROM oven/bun:slim AS build

WORKDIR /usr/src/app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

FROM oven/bun:slim

WORKDIR /usr/src/app

COPY --from=build /usr/src/app/dist ./dist
COPY --from=build /usr/src/app/dist-server ./dist-server
COPY --from=build /usr/src/app/package.json ./

ENV PORT=8081
ENV BASE_URL=http://localhost:8081
ENV DATABASE_PATH=/usr/src/app/data/mureview.db

EXPOSE 8081

CMD ["bun", "run", "start-prod"]
