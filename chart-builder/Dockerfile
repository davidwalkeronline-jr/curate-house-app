# Runs the Chord Chart Builder: the page, YouTube and Spotify links (yt-dlp + ffmpeg),
# chord recognition (madmom) and lyrics transcription (faster-whisper).
# The speech model downloads at build time; madmom ships its models in the package.
# Build from this folder:  docker build -t chord-chart-builder .
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip python3-dev build-essential git ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# madmom needs numpy 1.x and is built from source (the PyPI release does not support current Python)
RUN pip3 install --no-cache-dir --break-system-packages "numpy<2" cython scipy mido setuptools wheel \
 && pip3 install --no-cache-dir --break-system-packages --no-build-isolation \
      git+https://github.com/CPJKU/madmom@27f032e8947204902c675e5e341a3faf5dc86dae \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp faster-whisper "numpy<2"
ARG WHISPER_MODEL=base.en
ENV WHISPER_MODEL=$WHISPER_MODEL WHISPER_DIR=/models
RUN python3 -c "import os; from faster_whisper import WhisperModel; WhisperModel(os.environ['WHISPER_MODEL'], device='cpu', compute_type='int8', download_root='/models')" \
 && python3 -c "import madmom.features.chords"
WORKDIR /app
COPY . .
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server/server.js"]
