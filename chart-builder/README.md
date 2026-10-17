# Chord Chart Builder

A standalone app that listens to a song and drafts a numbers chart modeled on the MultiTracks chart layout: a roadmap of section badges, each section in a rounded box, chords (Nashville numbers, letters, or both) over lyrics, and band dynamics in the top right of each box. Every chart can be edited and downloaded as a PDF.

## Ways to bring in a song

* **Upload a file** (MP3, M4A, WAV, AAC, FLAC, OGG). This runs entirely in the browser.
* **Paste a YouTube or Spotify link.** Browsers cannot pull audio out of YouTube or Spotify, so links go through the small audio service in `server/`, which uses [yt-dlp](https://github.com/yt-dlp/yt-dlp). Spotify does not share its audio at all, so a Spotify track is matched by title and artist to the same song on YouTube.

## What it analyzes

All analysis happens in the browser:

* tempo, beats, and downbeats
* key and chords, including slash chords like 1/3
* song structure: Intro, Verse, Pre-Chorus, Chorus, Bridge, Instrumental, Turnaround, Tag, Outro, with repeats marked
* band dynamics per section (a marking from pp to ff plus cues like Keys + pad, Drums in, Build, Break down, Full band)
* lyrics, in this order: lyrics you paste, timed lyrics looked up on [LRCLIB](https://lrclib.net) from the title and artist, then an optional in-browser speech model (Whisper) that listens for them

## Running it

### Uploads only

Serve this folder with any static web server and open it, for example:

```
npx http-server chart-builder
```

Opening `index.html` straight from disk also works, but the PDF then uses Helvetica instead of Open Sans, because browsers block font loading from `file://`.

### With YouTube and Spotify links

The audio service serves the app and handles links. It needs Node 18 or newer and yt-dlp:

```
pip install yt-dlp
node chart-builder/server/server.js
```

Then open http://localhost:8787.

Or with Docker:

```
docker build -t chord-chart-builder chart-builder
docker run -p 8787:8787 chord-chart-builder
```

The Docker image can be deployed as is to any host that runs containers (Render, Railway, Fly.io, a VPS). Netlify and similar static hosts cannot run yt-dlp. If the page is hosted there, deploy the audio service elsewhere and either set `window.CB_CONFIG.audioService` in `index.html` to its address or paste the address under **Settings** in the app.

### Audio service settings

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `ALLOWED_ORIGINS` | `*` | Comma separated origins allowed to call the API, for example `https://curate.house` |
| `MAX_DURATION` | `900` | Longest song accepted, in seconds |
| `MAX_DOWNLOADS` | `3` | Downloads allowed at the same time |
| `RATE_LIMIT` | `30` | API requests per visitor per 10 minutes |
| `YTDLP_PATH` | `yt-dlp` | Path to the yt-dlp binary |
| `YTDLP_COOKIES` | (none) | Path to a cookies.txt file, for hosts where YouTube asks to confirm you are not a bot |

Keep yt-dlp up to date (`pip install -U yt-dlp`), since YouTube changes often. Downloading from YouTube is subject to YouTube's Terms of Service, so this is best kept to private use by your team.

## Files

* `index.html`: the app page and styles
* `js/theory.js`: keys, chord spelling, transposing, Nashville numbers
* `js/analysis.js`: audio analysis (beats, chords, structure)
* `js/build.js`: turns analysis and lyrics into chart sections, dynamics, and the roadmap
* `js/sources.js`: link import and lyrics lookup
* `js/pdf.js`: PDF layout
* `js/app.js`: the editor
* `server/server.js`: the audio service
* `fonts/`: Open Sans, under the SIL Open Font License (`fonts/OFL.txt`)
