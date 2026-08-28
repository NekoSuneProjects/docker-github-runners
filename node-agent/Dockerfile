FROM node:24-alpine

RUN apk add --no-cache ca-certificates docker-cli docker-cli-buildx

WORKDIR /app
COPY agent.js /app/agent.js
COPY supervisor.js /app/supervisor.js
COPY patch-agent.js /app/patch-agent.js
COPY workload-proxy.js /app/workload-proxy.js

RUN node --check /app/workload-proxy.js \
    && node --check /app/supervisor.js \
    && node --check /app/patch-agent.js \
    && node /app/patch-agent.js \
    && sed -i '/^[[:space:]]*timer\.unref();[[:space:]]*$/d' /app/agent.js \
    && node --check /app/agent.js

ENV NODE_ENV=production
ENV RUNNER_DIAG_DIR=/runner-diag
ENV RUNNER_WORK_DIR=/runner-work
ENV NODE_HOST_ROOT=/host
ENV NODE_RUNNER_STATUS_CACHE_SECONDS=90

USER root
STOPSIGNAL SIGTERM
CMD ["node", "/app/workload-proxy.js"]
