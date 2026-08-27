FROM node:24-alpine

RUN apk add --no-cache ca-certificates

WORKDIR /app

COPY agent.js /app/agent.js

ENV NODE_ENV=production
ENV RUNNER_DIAG_DIR=/runner-diag
ENV NODE_HOST_ROOT=/host

USER node

STOPSIGNAL SIGTERM

CMD ["node", "/app/agent.js"]
