# Curate Studio

In-browser mixing and mastering for Curate House. Drop in stems, pick a genre
or a reference song, and the Studio mixes and masters the track. Everything
runs locally in the browser (Web Workers); no audio is uploaded.

Open `studio/index.html` from any static host (it uses ES modules and module
workers, so it must be served over http(s), not opened as a file).

## How it works

1. **Ingest** (`engine/decode.js`, `engine/bfp.js`): WAV/AIFF parsed directly
   (incl. 24 bit, float, RF64, Broadcast WAV timestamps); other formats use the
   browser decoder. Stems are stored as block floating point to halve memory.
2. **Analyse** (`engine/features.js`): loudness, level statistics, tonal
   balance, sibilance, transients, periodicity, stereo image per stem.
3. **Classify** (`engine/classify.js`): role from the file name (with audio
   fallback); click and guide tracks are detected and muted; L/R pairs joined.
4. **Plan** (`engine/planner.js`, `engine/genres.js`): per stem high pass,
   adaptive EQ, compression, de-essing, gating, saturation, pan and sends,
   with levels set from loudness measured on the processed stems.
5. **Render** (`engine/strip.js`, `engine/reverb.js`): stems processed in
   parallel workers, summed with plate, hall/room and delay buses.
6. **Master** (`engine/master.js`): bus glue, tonal match EQ toward the genre
   curve or reference, stereo width with mono bass, warmth, transient clipper
   and a true peak lookahead limiter that lands exactly on the loudness target.

## Tests

```
cd studio
npm test
```

Covers BS.1770 / EBU R128 loudness, true peak, filters, dynamics, reverbs and
a full pipeline run on a synthetic multitrack session (`tests/synth.js`).
