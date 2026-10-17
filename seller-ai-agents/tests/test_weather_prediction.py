"""
Unit & Smoke Tests for Agent 2: Weather Data & Prediction Agent (MeteoCast).
Can be run via:
    python tests/test_weather_prediction.py
    pytest tests/test_weather_prediction.py
"""

import sys
import unittest
from pathlib import Path

MODULE_ROOT = Path(__file__).resolve().parent.parent
if str(MODULE_ROOT) not in sys.path:
    sys.path.insert(0, str(MODULE_ROOT))

from agents.weather_prediction.agent import predict_weather, predict_next_day_temperature, WeatherPredictionAgent


class TestWeatherPrediction(unittest.TestCase):

    def test_feature_prediction(self):
        res = predict_next_day_temperature(
            temp_max=34.5,
            temp_min=25.0,
            humidity=62.0,
            precip=0.5,
            wind=16.0
        )
        self.assertEqual(res.get("model_status"), "trained_and_ready")
        self.assertIsNotNone(res.get("predicted_next_day_temperature_celsius"))
        self.assertIn("mae_celsius", res.get("test_evaluation_metrics", {}))
        self.assertEqual(res.get("data_source_status"), "local_ml_model_inference")
        self.assertGreater(res.get("latency_ms"), 0.0)

    def test_extreme_temperature_prediction(self):
        res = predict_weather({"temperature_mean": 42.0, "temperature_max": 47.0, "relative_humidity_mean": 25.0})
        self.assertGreater(res.get("predicted_next_day_temperature_celsius"), 32.0)

    def test_class_instantiation(self):
        agent = WeatherPredictionAgent()
        self.assertIsNotNone(agent.model)
        res = agent.predict({"temperature_mean": 28.0})
        self.assertIn("predicted_next_day_temperature_celsius", res)


if __name__ == "__main__":
    unittest.main()
