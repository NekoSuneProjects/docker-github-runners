FROM node:24-alpine

RUN apk add --no-cache ca-certificates unzip su-exec \
    && mkdir -p /data \
    && chown node:node /data

WORKDIR /app

COPY package.json /app/package.json
RUN npm install --omit=dev --no-audit --no-fund

COPY server-v3.js /app/server.js
COPY server-realtime.js /app/server-realtime.js
COPY server-control.js /app/server-control.js
COPY server-websocket.js /app/server-websocket.js
COPY github-cache.js /app/github-cache.js
COPY github-persistent-cache.js /app/github-persistent-cache.js
COPY github-runner-store.js /app/github-runner-store.js
COPY github-workflow-store.js /app/github-workflow-store.js
COPY patch-workload.js /app/patch-workload.js
COPY patch-workflow-discovery.js /app/patch-workflow-discovery.js
COPY public /app/public
COPY entrypoint.sh /usr/local/bin/dashboard-entrypoint.sh

RUN node --check /app/patch-workload.js \
    && node --check /app/patch-workflow-discovery.js \
    && node --check /app/public/workload-ui.js \
    && node /app/patch-workflow-discovery.js \
    && node /app/patch-workload.js \
    && node --check /app/github-workflow-store.js \
    && node --check /app/server.js \
    && node --check /app/server-websocket.js \
    && sed -i 's#</body>#<script src="/runner-controls-v3.js"></script><script src="/workload-ui.js"></script></body>#' /app/public/index-v3.html \
    && chmod 0755 /usr/local/bin/dashboard-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=8080
ENV DASHBOARD_DATA_DIR=/data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1

STOPSIGNAL SIGTERM
USER root
ENTRYPOINT ["/usr/local/bin/dashboard-entrypoint.sh"]
CMD ["node", \
  "--require", "/app/github-cache.js", \
  "--require", "/app/github-persistent-cache.js", \
  "--require", "/app/github-runner-store.js", \
  "--require", "/app/github-workflow-store.js", \
  "--require", "/app/server-websocket.js", \
  "/app/server-control.js"]
