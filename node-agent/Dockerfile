FROM node:24-alpine

RUN apk add --no-cache ca-certificates docker-cli

WORKDIR /app
COPY agent.js /app/agent.js

ENV NODE_ENV=production
ENV RUNNER_DIAG_DIR=/runner-diag
ENV NODE_HOST_ROOT=/host

# The agent has the Docker socket mounted so root inside this tiny trusted
# container is already equivalent to host Docker control. Running as root also
# avoids host docker.sock GID mismatches on remote nodes.
USER root
STOPSIGNAL SIGTERM
CMD ["node", "/app/agent.js"]
