"""Recognize chords for the Chord Chart Builder with madmom's trained chord model.

Usage: python3 chords.py AUDIO_FILE
Prints {"chords": [[start, end, "C#:min"], ...]} as JSON (labels are root:maj, root:min, or N).
"""
import json
import sys
import warnings

warnings.filterwarnings("ignore")

from madmom.features.chords import CNNChordFeatureProcessor, CRFChordRecognitionProcessor


def main(path):
    segments = CRFChordRecognitionProcessor()(CNNChordFeatureProcessor()(path))
    json.dump({"chords": [[round(float(s), 3), round(float(e), 3), str(l)] for s, e, l in segments]}, sys.stdout)


if __name__ == "__main__":
    main(sys.argv[1])
