"""Transcribe sung lyrics with word timings for the Chord Chart Builder.

Usage: python3 transcribe.py AUDIO_FILE
Prints {"words": [{"text", "start", "end", "br"}]} as JSON, where br marks the
first word of each sung phrase so the chart keeps the singer's line breaks.
"""
import json
import os
import sys

from faster_whisper import WhisperModel

NOISE = {"[music]", "(music)", "[applause]", "(applause)", "♪", "♪♪"}


def main(path):
    name = os.environ.get("WHISPER_MODEL", "base.en")
    model = WhisperModel(name, device="cpu", compute_type="int8",
                         download_root=os.environ.get("WHISPER_DIR") or None)
    segments, _ = model.transcribe(
        path,
        language="en" if name.endswith(".en") else None,
        word_timestamps=True,
        vad_filter=True,
        beam_size=5,
        # songs repeat lines; conditioning on earlier text makes Whisper loop
        condition_on_previous_text=False,
    )
    words = []
    for seg in segments:
        first = True
        for w in seg.words or []:
            text = w.word.strip()
            if not text or text.lower() in NOISE:
                continue
            words.append({"text": text, "start": round(w.start, 2), "end": round(w.end, 2), "br": first})
            first = False
    json.dump({"words": words}, sys.stdout)


if __name__ == "__main__":
    main(sys.argv[1])
