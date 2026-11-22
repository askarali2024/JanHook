# JanHook — lightweight self-hosted webhook & HTTP request inspector
#
# Build:  docker build -t janhook .
# Run:    docker run -p 8001:8001 -v janhook-data:/app/data janhook

FROM node:20-alpine

WORKDIR /app

# Install production dependencies first for better layer caching
COPY package*.json ./
RUN npm install --omit=dev

# Application code
COPY . .

# Data directory (endpoints + captured requests) on a volume
RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    PORT=8001 \
    DATA_DIR=/app/data \
    MAX_REQUESTS_PER_BIN=100

EXPOSE 8001
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
