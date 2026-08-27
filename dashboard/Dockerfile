FROM node:24-alpine

RUN apk add --no-cache ca-certificates unzip su-exec \
    && mkdir -p /data \
    && chown node:node /data

WORKDIR /app
COPY server-v3.js /app/server.js
COPY server-realtime.js /app/server-realtime.js
COPY server-control.js /app/server-control.js
COPY public /app/public
COPY entrypoint.sh /usr/local/bin/dashboard-entrypoint.sh

RUN sed -i 's#</body>#<script src="/runner-controls.js"></script></body>#' /app/public/index-v3.html \
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
CMD ["node", "/app/server-control.js"]
