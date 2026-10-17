"""
Unit & Smoke Tests for Agent 1: Hindi Summarization Agent (DivyaVaani).
Can be run via:
    python tests/test_hindi_summarization.py
    pytest tests/test_hindi_summarization.py
"""

import sys
import unittest
from pathlib import Path

MODULE_ROOT = Path(__file__).resolve().parent.parent
if str(MODULE_ROOT) not in sys.path:
    sys.path.insert(0, str(MODULE_ROOT))

from agents.hindi_summarization.agent import summarize_hindi, HindiSummarizerAgent


class TestHindiSummarization(unittest.TestCase):

    def test_multi_sentence_summary(self):
        sample_text = (
            "भारतीय अंतरिक्ष अनुसंधान संगठन (इसरो) ने आज एक ऐतिहासिक मिशन को सफलता पूर्वक पूरा किया है। "
            "यह मिशन भारत के अंतरिक्ष विज्ञान के क्षेत्र में एक नया मील का पत्थर साबित होगा। "
            "वैज्ञानिकों ने बताया कि प्रक्षेपण यान ने उपग्रह को सटीक कक्षा में स्थापित कर दिया है। "
            "प्रधानमंत्री ने इसरो के वैज्ञानिकों को इस असाधारण उपलब्धि के लिए बधाई दी और राष्ट्र को गौरवान्वित बताया। "
            "इस उपग्रह से मौसम पूर्वानुमान और संचार नेटवर्क को काफी मजबूती मिलेगी।"
        )
        res = summarize_hindi(sample_text, max_sentences=2)
        self.assertEqual(res.get("model_status"), "trained_and_ready")
        self.assertTrue(len(res.get("summary", "")) > 0)
        self.assertLess(res.get("summary_length"), res.get("original_length"))
        self.assertGreater(res.get("compression_ratio"), 0.0)
        self.assertGreater(res.get("latency_ms"), 0.0)

    def test_empty_or_short_input_fallback(self):
        res = summarize_hindi("")
        self.assertEqual(res.get("summary"), "")
        self.assertEqual(res.get("status"), "invalid_input")

    def test_class_instantiation(self):
        agent = HindiSummarizerAgent()
        self.assertIsNotNone(agent.model_artifact)
        res = agent.summarize("भारत में डिजिटल भुगतान प्रणाली ने पिछले कुछ वर्षों में अभूतपूर्व प्रगति की है।")
        self.assertIn("summary", res)


if __name__ == "__main__":
    unittest.main()
