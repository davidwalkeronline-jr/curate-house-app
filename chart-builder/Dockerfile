# Runs the Chord Chart Builder page plus YouTube and Spotify links (yt-dlp + ffmpeg).
# Chords and lyrics are worked out in the browser; faster-whisper here is only a fallback
# for browsers that cannot run the speech model. Its model downloads at build time.
# Build from this folder:  docker build -t chord-chart-builder .
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages yt-dlp faster-whisper
ARG WHISPER_MODEL=base.en
ENV WHISPER_MODEL=$WHISPER_MODEL WHISPER_DIR=/models
RUN python3 -c "import os; from faster_whisper import WhisperModel; WhisperModel(os.environ['WHISPER_MODEL'], device='cpu', compute_type='int8', download_root='/models')"
WORKDIR /app
COPY . .
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server/server.js"]
