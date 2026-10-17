"""
datasets/weather_prediction/fetch_open_meteo.py
Fetches historical weather observations from Open-Meteo API:
https://open-meteo.com/en/docs/historical-weather-api
Open-Meteo data is licensed under CC BY 4.0.
"""

import sys
import pandas as pd
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent

def fetch_open_meteo(latitude=28.61, longitude=77.23, start_date="2023-01-01", end_date="2023-12-31"):
    print(f"Attempting to query Open-Meteo Historical API for ({latitude}, {longitude}) from {start_date} to {end_date}...")
    try:
        import requests
        url = "https://archive-api.open-meteo.com/v1/archive"
        params = {
            "latitude": latitude,
            "longitude": longitude,
            "start_date": start_date,
            "end_date": end_date,
            "daily": ["temperature_2m_max", "temperature_2m_min", "temperature_2m_mean",
                      "precipitation_sum", "wind_speed_10m_max"],
            "timezone": "auto"
        }
        res = requests.get(url, params=params, timeout=10)
        if res.status_code == 200:
            daily = res.json().get("daily", {})
            if "time" in daily:
                df = pd.DataFrame({
                    "date": daily["time"],
                    "temperature_mean": daily["temperature_2m_mean"],
                    "temperature_max": daily["temperature_2m_max"],
                    "temperature_min": daily["temperature_2m_min"],
                    "precipitation_sum": daily["precipitation_sum"],
                    "wind_speed_max": daily["wind_speed_10m_max"],
                })
                out_path = DATA_DIR / "open_meteo_live.csv"
                df.to_csv(out_path, index=False)
                print(f"Successfully retrieved and saved {len(df)} live observations to {out_path}")
                return True
    except Exception as e:
        print(f"Online Open-Meteo query skipped or unavailable ({e}).")
    
    print("Using bundled offline demonstration weather dataset.")
    return False

if __name__ == "__main__":
    fetch_open_meteo()
