FROM node:22-slim

# better-sqlite3 ships prebuilt binaries; build tools are a safety net for
# platforms without one (e.g. some ARM homelab hosts).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
ENV DB_PATH=/data/library.db
VOLUME /data
EXPOSE 3000

CMD ["node", "server.js"]
