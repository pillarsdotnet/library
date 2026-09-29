# Not a floating 24: from 24.19.0 on, Node can abort better-sqlite3 during
# garbage collection (https://github.com/nodejs/node/issues/65446). Move on
# once that is fixed, and keep CI's node-version in step.
FROM node:24.18.1-slim AS deps

# better-sqlite3 compiles from source on every install (its install script is
# node-gyp rebuild), so this stage needs a compiler. The runtime stage below
# copies only the finished node_modules and leaves the toolchain, some 280 MB,
# behind.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
# Install prod deps incl. optional platform binaries (sharp needs its prebuilt
# @img/sharp-linux-x64 for EPUB cover resizing).
RUN npm install --omit=dev

# Same base as above, so the compiled better-sqlite3 matches its Node and glibc.
FROM node:24.18.1-slim

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV PORT=3000
ENV DB_PATH=/data/library.db
VOLUME /data
EXPOSE 3000

CMD ["node", "server.js"]
