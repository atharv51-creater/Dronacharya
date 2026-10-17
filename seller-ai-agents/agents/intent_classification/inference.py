"""
inference.py
Standalone inference entry point for Agent 4: Text Intent Classification Agent (CogniRoute).
Usage:
    python inference.py
    python inference.py --query "Can you summarize this news article for me?"
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

from agent import classify_intent

DEFAULT_QUERY = "Can you summarize this long Hindi news article for me?"


def main():
    parser = argparse.ArgumentParser(description="Intent Classification Agent Inference")
    parser.add_argument("--query", default=DEFAULT_QUERY, help="Natural language user query")
    args = parser.parse_args()

    result = classify_intent(args.query)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
