"""
inference.py
Standalone inference entry point for Agent 3: Hindi Sentiment Analysis Agent (Bhaavna).
Usage:
    python inference.py
    python inference.py --text "यह उत्पाद बहुत ही शानदार और उपयोगी है!"
"""

import sys
import json
import argparse
from pathlib import Path

# Force UTF-8 on stdout
if sys.stdout.encoding != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except AttributeError:
        pass

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from agent import analyze_hindi_sentiment

DEFAULT_SAMPLE_TEXT = "यह उत्पाद वास्तव में बहुत ही शानदार और उपयोगी है, मुझे बहुत पसंद आया और इसकी गुणवत्ता लाजवाब है!"


def main():
    parser = argparse.ArgumentParser(description="Hindi Sentiment Agent Inference")
    parser.add_argument("--text", default=DEFAULT_SAMPLE_TEXT, help="Hindi customer review or text")
    args = parser.parse_args()

    result = analyze_hindi_sentiment(args.text)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
