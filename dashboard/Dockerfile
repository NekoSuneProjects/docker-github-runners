FROM node:24-alpine

RUN apk add --no-cache ca-certificates unzip

WORKDIR /app

COPY server.js /app/server.js
COPY public /app/public

RUN mkdir -p /data \
    && chown -R node:node /app /data

ENV NODE_ENV=production
ENV PORT=8080
ENV DASHBOARD_NODE_DATA_FILE=/data/nodes.json

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1

STOPSIGNAL SIGTERM

USER node

CMD ["node", "/app/server.js"]
