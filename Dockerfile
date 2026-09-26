# Beide Stages MUESSEN dieselbe libc-Basis nutzen (Debian/glibc), sonst passt
# das nativ kompilierte better-sqlite3-Binding aus der deps-Stage nicht zur
# Laufzeit-Stage (musl vs. glibc -> "libc.musl-x86_64.so.1: cannot open...").
# Debian ist ausserdem noetig fuer zuverlaessiges Headless-Chromium/WebGL
# (Thumbnail-Rendering) - Alpine hatte dort eigene Probleme, siehe README.
FROM node:20-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev

FROM node:20-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    ca-certificates \
    libvulkan1 \
    && rm -rf /var/lib/apt/lists/*
# libvulkan1: nur fuer das experimentelle GPU_ACCEL=true (siehe
# server/thumbnails.js, docker-compose.gpu.yml) noetig - Chromium braucht den
# Vulkan-Loader, um den ANGLE-Vulkan-Backend fuer WebGL zu nutzen. Schadet im
# normalen Software-Rendering-Betrieb nicht (paar hundert KB Paketgroesse).

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts
# Three.js-Viewer-Dateien fuer den Browser statisch bereitstellen
RUN mkdir -p ./public/vendor/three && \
    cp -r ./node_modules/three/build ./public/vendor/three/build && \
    cp -r ./node_modules/three/examples/jsm ./public/vendor/three/jsm && \
    node ./scripts/patch-3mfloader.js ./public/vendor/three/jsm/loaders/3MFLoader.js

ENV PORT=3000
ENV DATA_ROOT=/data
ENV DB_PATH=/app/db/archiv.sqlite
EXPOSE 3000
CMD ["node", "server/index.js"]
