"""
inference.py
Standalone inference entry point for Agent 2: Weather Data & Prediction Agent (MeteoCast).
Usage:
    python inference.py
    python inference.py --temp-mean 31.5 --humidity 65 --wind 15
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

from agent import predict_weather


def main():
    parser = argparse.ArgumentParser(description="Weather Prediction Agent Inference")
    parser.add_argument("--temp-mean", type=float, default=29.5, help="Mean temperature in Celsius")
    parser.add_argument("--temp-max", type=float, default=34.0, help="Max temperature in Celsius")
    parser.add_argument("--temp-min", type=float, default=25.0, help="Min temperature in Celsius")
    parser.add_argument("--humidity", type=float, default=65.0, help="Relative humidity percentage")
    parser.add_argument("--precip", type=float, default=0.1, help="Precipitation in mm")
    parser.add_argument("--wind", type=float, default=14.0, help="Wind speed in km/h")
    args = parser.parse_args()

    obs = {
        "temperature_mean": args.temp_mean,
        "temperature_max": args.temp_max,
        "temperature_min": args.temp_min,
        "relative_humidity_mean": args.humidity,
        "precipitation_sum": args.precip,
        "wind_speed_max": args.wind,
    }

    result = predict_weather(obs)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
