# Chord Chart Builder

A standalone app that listens to a song and drafts a numbers chart modeled on the MultiTracks chart layout: a roadmap of section badges, each section in a rounded box, chords (Nashville numbers, letters, or both) over lyrics, and band dynamics in the top right of each box. Every chart can be edited and downloaded as a PDF.

## Ways to bring in a song

* **Upload a file** (MP3, M4A, WAV, AAC, FLAC, OGG).
* **Paste a YouTube or Spotify link.** Browsers cannot pull audio out of YouTube or Spotify, so links go through the builder's server in `server/`, which uses [yt-dlp](https://github.com/yt-dlp/yt-dlp). Spotify does not share its audio at all, so a Spotify track is matched by title and artist to the same song on YouTube.

## What it analyzes

Chords, tempo, structure, and dynamics are analyzed in the browser. The server handles links and lyrics transcription.

* tempo, beats, and downbeats
* key and chords, including slash chords like 1/3
* song structure: Intro, Verse, Pre-Chorus, Chorus, Bridge, Instrumental, Turnaround, Tag, Outro, with repeats marked
* band dynamics per section (a marking from pp to ff plus cues like Keys + pad, Drums in, Build, Break down, Full band)
* lyrics, written automatically unless you paste them: first timed lyrics looked up on [LRCLIB](https://lrclib.net) from the title and artist, otherwise transcribed from the vocals by the server's speech model ([faster-whisper](https://github.com/SYSTRAN/faster-whisper)). Without the server, the browser tries a smaller speech model of its own, which is slower.

## Running it

The normal setup is one website: the server hosts the builder page and handles links and lyrics, so there is nothing to configure in the app.

### With Docker (recommended)

```
docker build -t chord-chart-builder chart-builder
docker run -p 8787:8787 chord-chart-builder
```

Then open http://localhost:8787. The image includes yt-dlp, faster-whisper, and the speech model. Deploy the same image to any host that runs containers (Render, Railway, Fly.io, a VPS) and the host's address is the app's address. Give it at least 1 GB of memory for the default model.

### On Render

The repository includes `render.yaml`. In Render, choose **New > Blueprint**, pick this repository, and confirm. Render builds the image and gives the app its own address (you can point a domain like charts.curate.house at it).

### Without Docker

Needs Node 18 or newer and Python 3:

```
pip install yt-dlp faster-whisper
node chart-builder/server/server.js
```

The speech model downloads the first time someone transcribes a song.

### Static hosting only

Any static host (Netlify, GitHub Pages) can serve this folder, but then links do not work and lyrics fall back to the slower in-browser model. To pair a static page with a server hosted elsewhere, set `window.CB_CONFIG.audioService` in `index.html` to the server's address and set `ALLOWED_ORIGINS` on the server.

### Server settings

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `WHISPER_MODEL` | `base.en` | Speech model. `small.en` is more accurate and needs about 2 GB of memory |
| `MAX_TRANSCRIBES` | `1` | Songs transcribed at the same time |
| `MAX_UPLOAD_MB` | `40` | Largest audio accepted for transcription |
| `ALLOWED_ORIGINS` | `*` | Comma separated origins allowed to call the API, for example `https://curate.house` |
| `MAX_DURATION` | `900` | Longest linked song accepted, in seconds |
| `MAX_DOWNLOADS` | `3` | Link downloads allowed at the same time |
| `RATE_LIMIT` | `30` | API requests per visitor per 10 minutes |
| `YTDLP_PATH` | `yt-dlp` | Path to the yt-dlp binary |
| `YTDLP_COOKIES` | (none) | Path to a cookies.txt file, for hosts where YouTube asks to confirm you are not a bot |

Keep yt-dlp up to date (`pip install -U yt-dlp`), since YouTube changes often. Downloading from YouTube is subject to YouTube's Terms of Service, so this is best kept to private use by your team. Transcribed lyrics are a draft: check them against the official lyrics before printing.

## Files

* `index.html`: the app page and styles
* `js/theory.js`: keys, chord spelling, transposing, Nashville numbers
* `js/analysis.js`: audio analysis (beats, chords, structure)
* `js/build.js`: turns analysis and lyrics into chart sections, dynamics, and the roadmap
* `js/sources.js`: link import, lyrics lookup, and server transcription
* `js/pdf.js`: PDF layout
* `js/app.js`: the editor
* `server/server.js`: the server (page, links, lyrics)
* `server/transcribe.py`: lyrics transcription with word timings
* `fonts/`: Open Sans, under the SIL Open Font License (`fonts/OFL.txt`)
