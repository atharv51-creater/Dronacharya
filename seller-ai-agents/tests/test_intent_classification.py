"""
Unit & Smoke Tests for Agent 4: Text Intent Classification Agent (CogniRoute).
Can be run via:
    python tests/test_intent_classification.py
    pytest tests/test_intent_classification.py
"""

import sys
import unittest
from pathlib import Path

MODULE_ROOT = Path(__file__).resolve().parent.parent
if str(MODULE_ROOT) not in sys.path:
    sys.path.insert(0, str(MODULE_ROOT))

from agents.intent_classification.agent import classify_intent, IntentClassifierAgent


class TestIntentClassification(unittest.TestCase):

    def test_supported_summarize_intent(self):
        query = "Can you summarize this long Hindi news article for me?"
        res = classify_intent(query)
        self.assertEqual(res.get("model_status"), "trained_and_ready")
        self.assertEqual(res.get("predicted_intent"), "summarize_text")
        self.assertTrue(res.get("is_supported"))
        self.assertEqual(res.get("recommended_service"), "hindi-summarizer-ai")

    def test_supported_weather_intent(self):
        query = "What will be the temperature in Delhi tomorrow?"
        res = classify_intent(query)
        self.assertEqual(res.get("predicted_intent"), "get_weather_prediction")
        self.assertTrue(res.get("is_supported"))
        self.assertEqual(res.get("recommended_service"), "weather-prediction-agent")

    def test_out_of_scope_query(self):
        query = "Can you book me a flight ticket to London tomorrow night?"
        res = classify_intent(query)
        self.assertEqual(res.get("predicted_intent"), "out_of_scope")
        self.assertFalse(res.get("is_supported"))
        self.assertIsNone(res.get("recommended_service"))

    def test_class_instantiation(self):
        agent = IntentClassifierAgent()
        self.assertIsNotNone(agent.model)
        self.assertIsNotNone(agent.vectorizer)
        res = agent.classify("What is the forecast?")
        self.assertIn("predicted_intent", res)


if __name__ == "__main__":
    unittest.main()
