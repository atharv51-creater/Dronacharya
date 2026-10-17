"""
datasets/weather_prediction/generate_demo_data.py
Generates a realistic multi-year daily meteorological dataset modeled on Open-Meteo Historical Weather API.
Includes temperature, humidity, precipitation, wind speed, pressure, and lag features.
Enforces chronological train, validation, and test splits.
"""

import math
import numpy as np
import pandas as pd
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent

def generate_weather_dataset(start_date="2022-01-01", days=730, seed=42):
    np.random.seed(seed)
    dates = pd.date_range(start=start_date, periods=days, freq="D")
    
    # Base seasonal cycle for reference station (e.g. New Delhi / 28.6°N latitude)
    # Seasonal high around May-June (day ~150), seasonal low around Jan (day ~15)
    day_of_year = dates.dayofyear.values
    seasonal_temp = 25.0 + 10.0 * np.sin(2 * np.pi * (day_of_year - 105) / 365.25)
    
    # Autoregressive temperature anomaly (weather patterns last several days)
    anomalies = np.zeros(days)
    for t in range(1, days):
        anomalies[t] = 0.75 * anomalies[t-1] + np.random.normal(0, 2.0)
    
    temp_mean = np.round(seasonal_temp + anomalies, 2)
    temp_max = np.round(temp_mean + np.random.uniform(4.0, 9.0, days), 2)
    temp_min = np.round(temp_mean - np.random.uniform(4.0, 8.0, days), 2)
    
    # Relative humidity (monsoon peaks in July-August, winter dry/hazy)
    monsoon_factor = np.clip(np.sin(2 * np.pi * (day_of_year - 170) / 365.25), 0, 1)
    base_humidity = 45.0 + 35.0 * monsoon_factor
    humidity = np.clip(np.round(base_humidity + np.random.normal(0, 10.0, days), 1), 15.0, 98.0)
    
    # Precipitation (rain events mostly during monsoon)
    precip_prob = 0.05 + 0.40 * monsoon_factor
    is_rain = np.random.rand(days) < precip_prob
    precipitation = np.where(is_rain, np.round(np.random.exponential(12.0, days), 1), 0.0)
    
    # Wind speed (km/h)
    wind_speed = np.clip(np.round(np.random.gamma(3.5, 3.0, days), 1), 2.0, 45.0)
    
    # Surface pressure (hPa)
    surface_pressure = np.round(1012.0 - 0.25 * (temp_mean - 25.0) + np.random.normal(0, 2.0, days), 1)
    
    df = pd.DataFrame({
        "date": dates.strftime("%Y-%m-%d"),
        "temperature_mean": temp_mean,
        "temperature_max": temp_max,
        "temperature_min": temp_min,
        "relative_humidity_mean": humidity,
        "precipitation_sum": precipitation,
        "wind_speed_max": wind_speed,
        "surface_pressure_mean": surface_pressure,
    })
    
    # Target: Next day's mean temperature
    df["target_next_day_temp"] = df["temperature_mean"].shift(-1)
    
    # Lag features
    df["temp_lag1"] = df["temperature_mean"].shift(1)
    df["temp_lag2"] = df["temperature_mean"].shift(2)
    df["temp_lag3"] = df["temperature_mean"].shift(3)
    df["humidity_lag1"] = df["relative_humidity_mean"].shift(1)
    df["precip_lag1"] = df["precipitation_sum"].shift(1)
    df["wind_lag1"] = df["wind_speed_max"].shift(1)
    
    # Rolling features
    df["temp_rolling_mean_3d"] = df["temperature_mean"].rolling(3).mean()
    df["temp_diff_1d"] = df["temperature_mean"] - df["temp_lag1"]
    
    # Cyclical day of year encodings
    df["day_sin"] = np.round(np.sin(2 * np.pi * day_of_year / 365.25), 4)
    df["day_cos"] = np.round(np.cos(2 * np.pi * day_of_year / 365.25), 4)
    
    # Drop rows with NaN from lags/target
    df = df.dropna().reset_index(drop=True)
    
    # Chronological splits (70% train, 15% validation, 15% test)
    n = len(df)
    n_train = int(n * 0.70)
    n_val = int(n * 0.15)
    
    train_df = df.iloc[:n_train].copy()
    val_df = df.iloc[n_train:n_train + n_val].copy()
    test_df = df.iloc[n_train + n_val:].copy()
    
    train_df["split"] = "train"
    val_df["split"] = "val"
    test_df["split"] = "test"
    
    combined = pd.concat([train_df, val_df, test_df], ignore_index=True)
    
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    combined.to_csv(DATA_DIR / "demo_data.csv", index=False)
    train_df.to_csv(DATA_DIR / "train.csv", index=False)
    val_df.to_csv(DATA_DIR / "val.csv", index=False)
    test_df.to_csv(DATA_DIR / "test.csv", index=False)
    
    print(f"Weather dataset generated successfully:")
    print(f"Total rows: {len(combined)} | Train: {len(train_df)} | Val: {len(val_df)} | Test: {len(test_df)}")

if __name__ == "__main__":
    generate_weather_dataset()
