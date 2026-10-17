# Agent 2: MeteoCast Next-Day Weather & Climate Predictor

A standalone, lightweight meteorological regression model forecasting next-day temperatures.

## Overview
- **Service Name**: `weather-prediction-agent` (MeteoCast)
- **Model Type**: Random Forest Regressor (`n_estimators=100`, `max_depth=12`, 17 features)
- **Dataset**: [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api) (ODbL / CC BY 4.0)
- **Chronological Data Split**:
  - Train: First 508 days
  - Validation: 108 days
  - Held-Out Test: 110 days
- **Held-Out Evaluation**:
  - Mean Absolute Error (MAE): **1.77 °C**
  - Root Mean Squared Error (RMSE): **2.24 °C**
  - R² Score: **0.8477** (explains 84.8% of daily temperature variance)
  - Average Latency: **~22 ms**
- **Data Provenance Rule**: Distinctly identifies `local_ml_model_inference` vs `live_open_meteo_api`. Synthetic or ML predictions are never presented as live weather observations.

## Directory Structure
```
weather_prediction/
├── agent.py               # Main WeatherPredictionAgent class & predict_weather() function
├── inference.py           # Standalone CLI / inference entry point
├── train.py               # Chronological training pipeline with MAE/RMSE evaluation
├── model/
│   ├── weather_predictor.joblib
│   └── weather_predictor_eval.json
└── data/
    ├── train.csv
    ├── val.csv
    ├── test.csv
    ├── demo_data.csv
    ├── generate_demo_data.py
    └── fetch_open_meteo.py
```

## Quick Start

### 1. Run Standalone Inference
```bash
python agents/weather_prediction/inference.py
```
Or with custom observations:
```bash
python agents/weather_prediction/inference.py --temp-mean 32.5 --temp-max 38.0 --humidity 55.0
```

### 2. Retrain Model
```bash
python agents/weather_prediction/train.py
```

### 3. Python API Usage
```python
from agents.weather_prediction.agent import predict_weather, WeatherPredictionAgent

# Functional API
result = predict_weather({
    "temperature_mean": 30.0,
    "temperature_max": 35.0,
    "temperature_min": 25.0,
    "relative_humidity_mean": 60.0,
    "wind_speed_max": 15.0
})
print("Forecast Temp:", result["predicted_next_day_temperature_celsius"], "°C")
print("Confidence Interval:", result["confidence_interval_celsius"])

# Object-Oriented API
agent = WeatherPredictionAgent()
res = agent.predict({"temperature_mean": 28.0})
```
