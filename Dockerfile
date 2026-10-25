FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    CONFIG_PATH=/app/config.docker.json \
    DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 3000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/api/printers >/dev/null || exit 1

CMD ["node", "server.js"]
