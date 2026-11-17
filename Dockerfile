# syntax=docker/dockerfile:1
# Glimmergrave game server (authoritative WebSocket backend). Build from the repository root:
#   docker build -t glimmergrave-server .
#   docker run --rm -p 8787:8787 -e ALLOWED_ORIGINS=https://your-site.netlify.app glimmergrave-server

# ---- build: bundle server + shared simulation into one file -------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
# Manifests first so the dependency layer is cached. All workspace manifests are needed for `npm ci`.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --workspace server --workspace shared --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY shared/src shared/src
COPY server/tsconfig.json server/
COPY server/src server/src
RUN npm run build --workspace server

# ---- runtime: node + a single self-contained bundle, no node_modules ----------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8787
WORKDIR /app
COPY --from=build --chown=node:node /app/server/dist/server.js ./server.js
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Node as PID 1 receives SIGTERM directly; the server shuts down gracefully on it.
CMD ["node", "server.js"]
