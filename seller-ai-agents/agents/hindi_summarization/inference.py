"""
inference.py
Standalone inference entry point for Agent 1: Hindi Summarization Agent (DivyaVaani).
Usage:
    python inference.py
    python inference.py --text "यहाँ हिंदी लेख दर्ज करें..." --sentences 2
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

from agent import summarize_hindi

DEFAULT_SAMPLE_TEXT = (
    "भारतीय अंतरिक्ष अनुसंधान संगठन (इसरो) ने आज एक ऐतिहासिक मिशन को सफलता पूर्वक पूरा किया है। "
    "यह मिशन भारत के अंतरिक्ष विज्ञान के क्षेत्र में एक नया मील का पत्थर साबित होगा। "
    "वैज्ञानिकों ने बताया कि प्रक्षेपण यान ने उपग्रह को सटीक कक्षा में स्थापित कर दिया है। "
    "प्रधानमंत्री ने इसरो के वैज्ञानिकों को इस असाधारण उपलब्धि के लिए बधाई दी और राष्ट्र को गौरवान्वित बताया। "
    "इस उपग्रह से मौसम पूर्वानुमान और संचार नेटवर्क को काफी मजबूती मिलेगी।"
)


def main():
    parser = argparse.ArgumentParser(description="Hindi Summarization Agent Inference")
    parser.add_argument("--text", default=DEFAULT_SAMPLE_TEXT, help="Hindi article text to summarize")
    parser.add_argument("--sentences", type=int, default=2, help="Number of sentences in summary")
    args = parser.parse_args()

    result = summarize_hindi(args.text, max_sentences=args.sentences)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
