# Curate Drum Pad

A 16 pad MIDI drum sampler for Pro Tools (AAX), plus VST3, Audio Unit and a standalone app.
Load your Splice drum samples onto the pads and play them from any MIDI keyboard or pad controller.

## Features

* **16 pads** laid out like a hardware pad controller (pad 1 at the bottom left).
* **Splice browser.** The left panel opens your Splice sample folder automatically
  (`~/Splice/sounds` on Mac, `Documents\Splice` on Windows). Click a file to preview it,
  then drag it onto a pad or double click to load it into the selected pad.
* **Drag and drop** straight from the Splice app, Finder or Explorer. Dropping several files
  on a pad fills that pad and the ones after it.
* **MIDI Learn.** Select a pad, click *MIDI Learn*, and hit a key on your keyboard.
  *Learn All 16* lets you press 16 keys in order to map every pad in one go.
  *Reset Notes* returns to the standard General MIDI drum layout (C1 to D#2, notes 36 to 51).
* **Per pad controls:** volume, pan, tune (±24 semitones), choke groups (for example an open
  hi hat cut off by a closed hi hat), and One Shot or Gate playback. Volume, pan and tune can
  be automated in Pro Tools.
* **Any sample rate.** 44.1 kHz and 48 kHz files (the two rates Splice uses) play at the
  correct pitch and length in 44.1, 48, 88.2 or 96 kHz sessions. 16, 24 and 32 bit WAV,
  AIFF, FLAC, MP3 and Ogg are supported.
* **Velocity sensitive**, with a stereo output.
* **Session recall.** Pro Tools saves which sample is on each pad, the note mapping and all
  settings with your session. Samples are referenced from their location on disk, so keep
  your Splice folder where it is. A pad whose file has moved shows "Missing".

## Getting it into Pro Tools

### 1. Download the build

Every push to this repository builds the plugin on GitHub's Mac and Windows machines.
Open the **Actions** tab, pick the latest successful **Build plugin** run, and download
`CurateDrumPad-macOS` or `CurateDrumPad-Windows` from the Artifacts section.

### 2. Install

* **Mac:** unzip the download, open `CurateDrumPad-macOS.tar.gz`, and double click
  `install-mac.command` (if macOS blocks it, right click it and choose Open). It asks for
  your password and installs the AAX plugin to
  `/Library/Application Support/Avid/Audio/Plug-Ins`.
* **Windows:** unzip, right click `install-windows.ps1`, and choose *Run with PowerShell*.
  It installs the AAX plugin to `C:\Program Files\Common Files\Avid\Audio\Plug-Ins`.

### 3. Open it

Create an **Instrument track**, click an insert slot, and choose
**multichannel plug-in > Instrument > Curate Drum Pad**. Set the track's MIDI input to your
keyboard (or "All") and record enable or input monitor the track to play the pads live.

## Important: Pro Tools plugin signing

Avid requires every AAX plugin to be **digitally signed** through PACE (the iLok company)
before the normal retail version of Pro Tools will load it. Without a signature, Pro Tools
skips the plugin when it starts up.

Until the plugin is signed you have two options:

1. **Pro Tools Developer.** Avid offers a free developer build of Pro Tools that loads
   unsigned plugins. Create a free account in the Avid Developer program
   (<https://developer.avid.com>), then download Pro Tools Developer from there.
2. **Use the standalone app or VST3 version** in the meantime. The standalone app works with
   your MIDI keyboard and audio interface directly (open *Options > Audio/MIDI Settings*).

To make it load in your regular Pro Tools:

1. Join the Avid Developer program (free) and request access to the AAX signing tools.
   Avid passes the request on to PACE, who provide the signing tool (`wraptool`) and a
   developer signing account linked to an iLok account.
2. Once you have them, the build workflow can sign the plugin automatically. The signing
   credentials are stored as GitHub repository secrets, never in the code.

Check the current terms with Avid and PACE when you apply; at the time of writing the AAX
SDK and signing tools are offered without charge to registered developers.

## Building it yourself

You need CMake 3.22 or newer plus Xcode (Mac) or Visual Studio 2022 (Windows). JUCE 8,
which includes the AAX SDK, is downloaded automatically.

```sh
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release
```

The plugins land in `build/CurateDrumPad_artefacts/Release/`.

To run the engine tests (sample rate handling, MIDI learn, choke groups, session recall):

```sh
cmake -B build -DDRUMPAD_BUILD_TESTS=ON
cmake --build build --config Release --target DrumPadTests
./build/DrumPadTests_artefacts/Release/DrumPadTests
```

## Project layout

| Path | Contents |
|---|---|
| `Source/PluginProcessor.*` | Audio engine: sample loading, MIDI handling, voices, state |
| `Source/PluginEditor.*` | Interface: pad grid, sample browser, pad settings |
| `Tests/EngineTests.cpp` | Headless engine tests |
| `scripts/` | Mac and Windows installers |
| `.github/workflows/build.yml` | Mac and Windows builds on GitHub Actions |
