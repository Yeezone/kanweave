# syntax=docker/dockerfile:1
# 云端部署镜像：一个 node 进程，零运行时 npm 依赖（tsdown 已把代码打进 lib/）。
FROM node:24-bookworm-slim AS build
WORKDIR /app

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# 依赖只用于构建（tsdown/typescript/vitest），运行期不需要。
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsdown.config.ts vitest.config.ts ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN pnpm run build

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    KW_HOST=0.0.0.0 \
    KW_PORT=4280 \
    KW_DATA_DIR=/data

COPY package.json ./
COPY --from=build /app/lib ./lib
COPY --from=build /app/public ./public

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 4280

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.KW_PORT||4280)+'/kanweave/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "lib/standalone.js"]
