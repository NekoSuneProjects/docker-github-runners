FROM node:24-alpine

RUN apk add --no-cache ca-certificates docker-cli docker-cli-buildx

WORKDIR /app
COPY agent.js /app/agent.js
COPY supervisor.js /app/supervisor.js
COPY patch-agent.js /app/patch-agent.js
COPY workload-proxy.js /app/workload-proxy.js

# Keep the heartbeat timer referenced and reduce direct GitHub runner-state
# calls. Cleanup/stuck-recovery still force a fresh status check for safety.
RUN node /app/patch-agent.js \
    && sed -i '/^[[:space:]]*timer\.unref();[[:space:]]*$/d' /app/agent.js

ENV NODE_ENV=production
ENV RUNNER_DIAG_DIR=/runner-diag
ENV RUNNER_WORK_DIR=/runner-work
ENV NODE_HOST_ROOT=/host
ENV NODE_RUNNER_STATUS_CACHE_SECONDS=90

# The agent has the Docker socket mounted, which is already host-root-equivalent.
# Root also avoids host docker.sock GID mismatches across remote nodes.
USER root
STOPSIGNAL SIGTERM
CMD ["node", "/app/workload-proxy.js"]
