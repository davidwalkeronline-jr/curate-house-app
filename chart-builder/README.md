# Chord Chart Builder

A standalone app that listens to a song and drafts a numbers chart modeled on the MultiTracks chart layout: a roadmap of section badges, each section in a rounded box, chords (Nashville numbers, letters, or both) over lyrics, and band dynamics in the top right of each box. Every chart can be edited and downloaded as a PDF.

## Ways to bring in a song

* **Upload a file** (MP3, M4A, WAV, AAC, FLAC, OGG).
* **Paste a YouTube or Spotify link.** Browsers cannot pull audio out of YouTube or Spotify, so links go through the builder's server in `server/`, which uses [yt-dlp](https://github.com/yt-dlp/yt-dlp). Spotify does not share its audio at all, so a Spotify track is matched by title and artist to the same song on YouTube.

## What it analyzes

Everything is worked out on the user's own device, in the browser: no audio is sent anywhere for analysis. Chords come from a JavaScript port of the [crema](https://github.com/bmcfee/crema) chord model, which recognizes major, minor, sus2, sus4, 6th, 7th, diminished and augmented chords plus the bass note, so slash chords appear too. A full song takes a few seconds on a typical computer. The server is only needed for YouTube and Spotify links.

* tempo, beats, and downbeats
* key and chords, including sus, 7th and slash chords like 4sus2 and 1/3
* song structure: Intro, Verse, Pre-Chorus, Chorus, Bridge, Instrumental, Turnaround, Tag, Outro, with repeats marked
* band dynamics per section (a marking from pp to ff plus cues like Keys + pad, Drums in, Build, Break down, Full band)
* lyrics, written automatically unless you paste them: first timed lyrics looked up on [LRCLIB](https://lrclib.net) from the title and artist, otherwise transcribed from the vocals by a speech model (Whisper base.en through [transformers.js](https://github.com/huggingface/transformers.js)) running in the browser. It downloads about 130 MB the first time and is fastest in browsers with WebGPU. If a browser cannot run it, the server's copy of the model is used instead.

## Running it

The normal setup is one website: the server hosts the builder page and handles links and lyrics, so there is nothing to configure in the app.

### With Docker (recommended)

```
docker build -t chord-chart-builder chart-builder
docker run -p 8787:8787 chord-chart-builder
```

Then open http://localhost:8787. The image includes yt-dlp, ffmpeg, and faster-whisper (the lyrics fallback). Deploy the same image to any host that runs containers (Render, Railway, Fly.io, a VPS) and the host's address is the app's address. The server does no chord work, so a small plan is fine. Lyrics fall back to it only when a browser cannot run the speech model, and that is slow on small plans.

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

Any static host (Netlify, GitHub Pages) can serve this folder. `window.CB_CONFIG.audioService` in `index.html` points the page at the server for links and lyrics; it is set to the Render deployment, https://curate-house-charts.onrender.com. If the server is unreachable, links do not work and lyrics fall back to the slower in-browser model.

### Server settings

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `WHISPER_MODEL` | `base.en` | Speech model. `small.en` is more accurate and needs about 2 GB of memory |
| `MAX_UPLOAD_MB` | `40` | Largest audio accepted for fallback lyrics transcription |
| `ALLOWED_ORIGINS` | `*` | Comma separated origins allowed to call the API, for example `https://curate.house` |
| `MAX_DURATION` | `900` | Longest linked song accepted, in seconds |
| `MAX_DOWNLOADS` | `3` | Link downloads allowed at the same time |
| `RATE_LIMIT` | `30` | API requests per visitor per 10 minutes |
| `YTDLP_PATH` | `yt-dlp` | Path to the yt-dlp binary |
| `FFMPEG_PATH` | `ffmpeg` | Path to ffmpeg, used to convert link audio to MP3 so every browser can read it |
| `YTDLP_COOKIES` | (none) | Path to a cookies.txt file, for hosts where YouTube asks to confirm you are not a bot |

Keep yt-dlp up to date (`pip install -U yt-dlp`), since YouTube changes often. Downloading from YouTube is subject to YouTube's Terms of Service, so this is best kept to private use by your team. Transcribed lyrics are a draft: check them against the official lyrics before printing.

## Files

* `index.html`: the app page and styles
* `js/theory.js`: keys, chord spelling, transposing, Nashville numbers
* `js/analysis.js`: audio analysis (beats, bars, structure; basic chord detection as a last resort)
* `js/chords.js`: the crema chord model running in the browser
* `models/`: the chord model's weights (`crema-chord.bin`, `crema-chord.json`)
* `js/build.js`: turns analysis and lyrics into chart sections, dynamics, and the roadmap
* `js/sources.js`: link import, lyrics lookup, and server transcription
* `js/pdf.js`: PDF layout
* `js/app.js`: the editor
* `server/server.js`: the server (page, links, lyrics)
* `server/transcribe.py`: fallback lyrics transcription with word timings
* `fonts/`: Open Sans, under the SIL Open Font License (`fonts/OFL.txt`)

## Credits

* Chord model: crema by Brian McFee, BSD 2-Clause License (`models/CREMA-LICENSE.md`). Converted to run in the browser.
* Open Sans, SIL Open Font License (`fonts/OFL.txt`).
