# One Dockerfile for both images: --build-arg VARIANT=slim (Debian, the
# default) or VARIANT=alpine. CI builds each for amd64 and arm64.
ARG VARIANT=slim

FROM node:24-${VARIANT} AS deps

# better-sqlite3 compiles from source on every install (its install script is
# node-gyp rebuild), so this stage needs a compiler. The runtime stage below
# copies only the finished node_modules and leaves the toolchain, some 280 MB,
# behind.
RUN if [ -f /etc/alpine-release ]; then \
      apk add --no-cache python3 make g++; \
    else \
      apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
      && rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /app
COPY package*.json ./
# Install prod deps incl. optional platform binaries (sharp needs its prebuilt
# @img/sharp-<platform> for EPUB cover resizing).
RUN npm install --omit=dev

# Same base as above, so the compiled better-sqlite3 matches its Node and libc.
FROM node:24-${VARIANT}

# Alpine ships no /usr/share/zoneinfo, so musl ignores TZ and SQLite's
# date('now','localtime') -- which decides what is overdue -- stays on UTC,
# while Node's own timezone data makes the startup log name the right zone.
# test/timezone.test.mjs catches it. Debian slim already has tzdata.
RUN if [ -f /etc/alpine-release ]; then apk add --no-cache tzdata; fi

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV PORT=3000
ENV DB_PATH=/data/library.db
VOLUME /data
EXPOSE 3000

CMD ["node", "server.js"]
