# Interner Helfer-Container fuer 3D Mesh Hub Stufe 3 (Slicer-basierte
# Filament-Schaetzung). Nur ueber docker-compose.slicer.yml aktiviert - wer
# Stufe 3 nicht nutzt, baut/pullt diesen Container gar nicht mit.
#
# WICHTIG (verifiziert 29.09.2026 durch echten Testslice): urspruenglich war
# hier node:20-slim (Debian Bookworm, glibc 2.36) geplant. Die OrcaSlicer-
# v2.4.2-AppImage-Binary ist gegen glibc 2.38 / GLIBCXX_3.4.32 gelinkt und
# startet auf Bookworm NICHT ("version GLIBC_2.38 not found"). Deshalb
# Ubuntu 24.04 (glibc 2.39) als Basis, Node wird separat installiert.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Node.js 20 via NodeSource (Ubuntu 24.04 bringt kein aktuelles Node mit).
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /etc/apt/keyrings/nodesource.asc \
  && echo "deb [signed-by=/etc/apt/keyrings/nodesource.asc] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
  && apt-get update && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# xvfb + GL-/X-/WebKitGTK-Bibliotheken: OrcaSlicer ist trotz "CLI-Modus"
# intern auf das wxWidgets-GUI-Toolkit aufgebaut (inkl. eines WebKitGTK-
# Panels) und braucht laut echtem Testslice zwingend: libOpenGL (libgl1 /
# libglu1-mesa / libglvnd), WebKitGTK 4.1 (libwebkit2gtk-4.1-0) und eine
# funktionierende Anzeige (xvfb-run). Diese komplette Liste wurde am
# 29.09.2026 durch iteratives Testen der tatsaechlichen Fehlermeldungen
# ermittelt, nicht geraten.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    wget \
    ca-certificates \
    libgl1 \
    libglu1-mesa \
    libglvnd0 \
    libegl1 \
    libxkbcommon0 \
    libnss3 \
    libdbus-1-3 \
    libxrandr2 \
    libxi6 \
    libxcursor1 \
    libxcomposite1 \
    libxdamage1 \
    libasound2t64 \
    libwebkit2gtk-4.1-0 \
    fontconfig \
  && rm -rf /var/lib/apt/lists/*

# OrcaSlicer AppImage herunterladen und extrahieren (kein FUSE im Container
# noetig dank --appimage-extract).
ARG ORCA_TAG=v2.4.2
ARG ORCA_ASSET=OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.4.2.AppImage
RUN wget -q "https://github.com/OrcaSlicer/OrcaSlicer/releases/download/${ORCA_TAG}/${ORCA_ASSET}" -O /tmp/orca.AppImage \
  && chmod +x /tmp/orca.AppImage \
  && cd /opt && /tmp/orca.AppImage --appimage-extract \
  && mv squashfs-root /opt/orcaslicer \
  && rm /tmp/orca.AppImage

# XDG_RUNTIME_DIR: OrcaSlicer bricht ohne gueltiges, existierendes Verzeichnis
# hier sofort ab ("XDG_RUNTIME_DIR is invalid or not set", verifiziert
# 29.09.2026 durch echten Testslice). server.js legt es beim Start zusaetzlich
# defensiv nochmal an (chmod 700) - dieser RUN-Schritt sorgt dafuer, dass es
# unabhaengig vom Node-Prozess bereits im Image existiert.
RUN mkdir -p /tmp/xdgrun && chmod 700 /tmp/xdgrun
ENV XDG_RUNTIME_DIR=/tmp/xdgrun

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./

ENV PORT=4001
ENV ORCA_BIN=/opt/orcaslicer/AppRun
EXPOSE 4001
CMD ["node", "server.js"]
