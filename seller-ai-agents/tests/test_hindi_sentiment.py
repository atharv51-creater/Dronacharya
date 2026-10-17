"""
Unit & Smoke Tests for Agent 3: Hindi Sentiment Analysis Agent (Bhaavna).
Can be run via:
    python tests/test_hindi_sentiment.py
    pytest tests/test_hindi_sentiment.py
"""

import sys
import unittest
from pathlib import Path

MODULE_ROOT = Path(__file__).resolve().parent.parent
if str(MODULE_ROOT) not in sys.path:
    sys.path.insert(0, str(MODULE_ROOT))

from agents.hindi_sentiment.agent import analyze_hindi_sentiment, HindiSentimentAgent


class TestHindiSentiment(unittest.TestCase):

    def test_positive_sentiment(self):
        text = "यह उत्पाद वास्तव में बहुत ही शानदार और उपयोगी है, मुझे बहुत पसंद आया।"
        res = analyze_hindi_sentiment(text)
        self.assertEqual(res.get("model_status"), "trained_and_ready")
        self.assertEqual(res.get("sentiment"), "positive")
        self.assertGreater(res.get("confidence"), 0.33)
        self.assertIn("probabilities", res)

    def test_negative_sentiment(self):
        text = "यह सेवा बहुत ही घटिया और बेकार है, पैसे बर्बाद हो गए।"
        res = analyze_hindi_sentiment(text)
        self.assertEqual(res.get("model_status"), "trained_and_ready")
        self.assertEqual(res.get("sentiment"), "negative")

    def test_empty_input_fallback(self):
        res = analyze_hindi_sentiment("")
        self.assertEqual(res.get("sentiment"), "neutral")

    def test_class_instantiation(self):
        agent = HindiSentimentAgent()
        self.assertIsNotNone(agent.model)
        self.assertIsNotNone(agent.vectorizer)
        res = agent.analyze("यह एक सामान्य समीक्षा है।")
        self.assertIn("sentiment", res)


if __name__ == "__main__":
    unittest.main()
