# Not a floating 24: from 24.19.0 on, Node can abort better-sqlite3 during
# garbage collection (https://github.com/nodejs/node/issues/65446). Move on
# once that is fixed, and keep CI's node-version in step.
FROM node:24.18.1-slim

# better-sqlite3 ships prebuilt binaries; build tools are a safety net for
# platforms without one (e.g. some ARM homelab hosts).
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
# Install prod deps incl. optional platform binaries (sharp needs its prebuilt
# @img/sharp-linux-x64 for EPUB cover resizing).
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
ENV DB_PATH=/data/library.db
VOLUME /data
EXPOSE 3000

CMD ["node", "server.js"]
