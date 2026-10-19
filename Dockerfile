# BeamDesk server: signaling + web app in one small image.
#   docker build -t beamdesk-server .
#   docker run -p 8080:8080 -v beamdesk-data:/data beamdesk-server

FROM node:26-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY server/package.json server/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/
# Only what the server and web app need (skips Electron and the native input driver).
RUN npm ci -w packages/core -w server -w apps/web --include-workspace-root=false --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/core packages/core
COPY server server
COPY apps/web apps/web
ARG BEAMDESK_SERVER_URL=""
RUN npm run build -w apps/web && npm run build -w server

FROM node:26-alpine
LABEL org.opencontainers.image.title="BeamDesk server" \
      org.opencontainers.image.description="Signaling server and web app for BeamDesk, the open-source remote desktop" \
      org.opencontainers.image.source="https://github.com/Safiullah-Rahu/BeamDesk" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data WEB_ROOT=/app/web
WORKDIR /app
COPY --from=build /src/server/dist ./dist
COPY --from=build /src/apps/web/dist ./web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
CMD ["node", "dist/server.mjs"]
