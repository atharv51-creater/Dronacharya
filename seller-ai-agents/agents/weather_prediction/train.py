"""
Training Pipeline for Agent 2: Next-Day Weather & Temperature Prediction.
Trains Random Forest Regressor on chronological historical observations from Open-Meteo.
Uses chronological held-out validation to prevent future-data leakage.
Saves model artifacts to model/weather_predictor.joblib and model/weather_predictor_eval.json.
"""

import sys
import json
from pathlib import Path
import pandas as pd
import numpy as np
import joblib
from sklearn.ensemble import RandomForestRegressor
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

CURRENT_DIR = Path(__file__).resolve().parent
DATA_DIR = CURRENT_DIR / "data"
MODEL_DIR = CURRENT_DIR / "model"
MODEL_DIR.mkdir(parents=True, exist_ok=True)
MODEL_PATH = MODEL_DIR / "weather_predictor.joblib"
EVAL_PATH = MODEL_DIR / "weather_predictor_eval.json"

FEATURE_COLS = [
    "temperature_mean",
    "temperature_max",
    "temperature_min",
    "relative_humidity_mean",
    "precipitation_sum",
    "wind_speed_max",
    "surface_pressure_mean",
    "temp_lag1",
    "temp_lag2",
    "temp_lag3",
    "humidity_lag1",
    "precip_lag1",
    "wind_lag1",
    "temp_rolling_mean_3d",
    "temp_diff_1d",
    "day_sin",
    "day_cos"
]

TARGET_COL = "target_next_day_temp"


def train_weather_predictor():
    print("============================================================")
    print("Training Agent 2: Next-Day Weather & Temperature Predictor")
    print("============================================================")

    train_path = DATA_DIR / "train.csv"
    val_path = DATA_DIR / "val.csv"
    test_path = DATA_DIR / "test.csv"

    if not train_path.exists():
        from data.generate_demo_data import generate_weather_dataset
        generate_weather_dataset()

    df_train = pd.read_csv(train_path)
    df_val = pd.read_csv(val_path)
    df_test = pd.read_csv(test_path)

    print(f"Loaded {len(df_train)} train, {len(df_val)} val, {len(df_test)} test chronological observations.")

    # Combine train + val for final fit, keep test strictly held out
    df_fit = pd.concat([df_train, df_val], ignore_index=True)

    X_train = df_fit[FEATURE_COLS]
    y_train = df_fit[TARGET_COL]

    X_test = df_test[FEATURE_COLS]
    y_test = df_test[TARGET_COL]

    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_test_scaled = scaler.transform(X_test)

    model = RandomForestRegressor(
        n_estimators=100,
        max_depth=12,
        min_samples_split=4,
        random_state=42,
        n_jobs=-1
    )
    model.fit(X_train_scaled, y_train)

    bundle = {
        "model_type": "RandomForestRegressor",
        "model": model,
        "scaler": scaler,
        "features": FEATURE_COLS,
        "feature_names": FEATURE_COLS,
        "target": TARGET_COL,
        "n_features": len(FEATURE_COLS),
        "framework": "scikit-learn",
        "dataset_name": "Open-Meteo Historical Weather (New Delhi)",
        "split_method": "chronological_held_out"
    }

    joblib.dump(bundle, MODEL_PATH)
    print(f"Saved trained weather model bundle to {MODEL_PATH}")

    # Evaluate on held-out test split
    y_pred = model.predict(X_test_scaled)

    mae = float(mean_absolute_error(y_test, y_pred))
    rmse = float(np.sqrt(mean_squared_error(y_test, y_pred)))
    r2 = float(r2_score(y_test, y_pred))

    eval_report = {
        "agent": "weather_predictor",
        "model_type": "RandomForestRegressor",
        "dataset": "Open-Meteo Historical Weather Observations",
        "split_type": "chronological_held_out",
        "test_samples": len(df_test),
        "held_out_metrics": {
            "test_mae": f"{round(mae, 2)} °C",
            "test_rmse": f"{round(rmse, 2)} °C",
            "test_r2": round(r2, 4)
        },
        "raw_metrics": {
            "test_mae": round(mae, 2),
            "test_rmse": round(rmse, 2),
            "test_r2": round(r2, 4)
        }
    }

    with open(EVAL_PATH, "w", encoding="utf-8") as f:
        json.dump(eval_report, f, indent=2)

    print("\n[Chronological Test Set Evaluation]")
    print(f"- Mean Absolute Error (MAE): {round(mae, 2)} C")
    print(f"- Root Mean Squared Error (RMSE): {round(rmse, 2)} C")
    print(f"- Coefficient of Determination (R2): {round(r2, 4)}")
    print(f"Evaluation report saved to {EVAL_PATH}")

    return eval_report


if __name__ == "__main__":
    train_weather_predictor()
