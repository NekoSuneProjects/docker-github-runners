FROM node:24-alpine

RUN apk add --no-cache ca-certificates unzip

WORKDIR /app

COPY server.js /app/server.js
COPY public /app/public

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

USER node

CMD ["node", "/app/server.js"]
