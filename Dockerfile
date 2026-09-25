# syntax=docker/dockerfile:1

# Deskradio: ein Prozess, der Internetradio in einen Discord-Sprachkanal streamt.
FROM node:22-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# ---------------------------------------------------------------- deps
FROM base AS deps
COPY package.json package-lock.json* ./
# Erst die Dev-Abhängigkeiten mit: der Build braucht den TypeScript-Compiler.
RUN npm ci --include=dev --no-audit --no-fund

# --------------------------------------------------------------- build
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------- production
FROM base AS production
ARG TARGETARCH
# ffmpeg wandelt die MP3-Streams in Opus, das Discord annimmt.
# yt-dlp lädt Wünsche von YouTube und SoundCloud. Die Debian-Fassung ist zu
# alt, YouTube ändert ständig etwas; daher die aktuelle direkt vom Projekt,
# passend zur Architektur. Als JavaScript-Laufzeit für YouTube dient das Node des Images.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && case "${TARGETARCH:-amd64}" in \
      amd64) asset=yt-dlp_linux ;; \
      arm64) asset=yt-dlp_linux_aarch64 ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}" \
 && chmod 755 /usr/local/bin/yt-dlp \
 && apt-get purge -y curl && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist

# Sender, Lautstärke und an/aus. Ohne Volume beginnt jeder Container mit den Standardwerten.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
ENV RADIO_STATE_FILE=/app/data/state.json \
    RADIO_CACHE_DIR=/tmp/deskradio-cache \
    HEALTH_PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

LABEL org.opencontainers.image.title="Deskradio" \
      org.opencontainers.image.description="Self-hosted Discord radio bot" \
      org.opencontainers.image.source="https://github.com/enricofranke/deskradio" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.authors="Enrico Franke"

USER node
CMD ["node", "dist/index.js"]
