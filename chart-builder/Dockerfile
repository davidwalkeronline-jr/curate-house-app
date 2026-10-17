# Runs the Chord Chart Builder: the page, YouTube and Spotify links (yt-dlp), and lyrics
# transcription (faster-whisper). The speech model downloads at build time.
# Build from this folder:  docker build -t chord-chart-builder .
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp faster-whisper \
 && rm -rf /var/lib/apt/lists/*
ARG WHISPER_MODEL=base.en
ENV WHISPER_MODEL=$WHISPER_MODEL WHISPER_DIR=/models
RUN python3 -c "import os; from faster_whisper import WhisperModel; WhisperModel(os.environ['WHISPER_MODEL'], device='cpu', compute_type='int8', download_root='/models')"
WORKDIR /app
COPY . .
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server/server.js"]
