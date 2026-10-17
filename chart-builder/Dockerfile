# Runs the Chord Chart Builder page plus the audio service for YouTube and Spotify links.
# Build from this folder:  docker build -t chord-chart-builder .
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server/server.js"]
