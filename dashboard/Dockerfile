FROM node:24-alpine

RUN apk add --no-cache ca-certificates unzip su-exec \
    && mkdir -p /data \
    && chown node:node /data

WORKDIR /app
COPY server-v3.js /app/server.js
COPY server-realtime.js /app/server-realtime.js
COPY public /app/public
COPY entrypoint.sh /usr/local/bin/dashboard-entrypoint.sh

# Add navigation + realtime client to both dashboard generations. v3 is the
# current page served by server-v3.js; index.html is retained for compatibility.
RUN for page in /app/public/index-v3.html /app/public/index.html; do \
      if [ -f "$page" ]; then \
        sed -i 's#<a href="/logout" class="btn danger">Logout</a>#<a href="/docs.html" class="btn">Docs</a><a href="/logout" class="btn danger">Logout</a>#' "$page"; \
        sed -i 's#<a class="btn danger" href="/logout">Logout</a>#<a class="btn" href="/docs.html">Docs</a><a class="btn danger" href="/logout">Logout</a>#' "$page"; \
        sed -i 's#</body>#<script src="/realtime.js"></script></body>#' "$page"; \
      fi; \
    done \
    && chmod 0755 /usr/local/bin/dashboard-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=8080
ENV DASHBOARD_DATA_DIR=/data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1

STOPSIGNAL SIGTERM

# Runtime begins as root only so a host bind mount such as ./data:/data can be
# repaired. The entrypoint immediately drops privileges to the node user.
USER root
ENTRYPOINT ["/usr/local/bin/dashboard-entrypoint.sh"]
CMD ["node", "/app/server-realtime.js"]
