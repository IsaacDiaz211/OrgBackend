FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY api ./api
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK CMD bun --bun fetch http://localhost:3000/api/v1/health || exit 1
CMD ["bun", "run", "src/server.ts"]
