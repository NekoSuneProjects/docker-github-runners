FROM node:24-alpine

RUN apk add --no-cache ca-certificates docker-cli docker-cli-buildx

WORKDIR /app
COPY agent.js /app/agent.js

ENV NODE_ENV=production
ENV RUNNER_DIAG_DIR=/runner-diag
ENV NODE_HOST_ROOT=/host

# The agent has the Docker socket mounted, which is already host-root-equivalent.
# Root also avoids host docker.sock GID mismatches across remote nodes.
USER root
STOPSIGNAL SIGTERM
CMD ["node", "/app/agent.js"]
