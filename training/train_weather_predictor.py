"""
training/train_weather_predictor.py
Trains a Random Forest Regressor for next-day temperature forecasting.
Uses Open-Meteo meteorological features with chronological train, val, and test splits.
Saves model to models/weather_predictor.joblib and evaluation metrics to models/weather_predictor_eval.json.
"""

import json
import joblib
import numpy as np
import pandas as pd
from pathlib import Path
from sklearn.ensemble import RandomForestRegressor
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "datasets" / "weather_prediction"
MODEL_DIR = BASE_DIR / "models"
MODEL_DIR.mkdir(parents=True, exist_ok=True)

FEATURE_COLUMNS = [
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

TARGET_COLUMN = "target_next_day_temp"

def train_weather_predictor():
    print("=" * 60)
    print("Training Agent 2: Next-Day Weather & Temperature Predictor")
    print("=" * 60)
    
    train_path = DATA_DIR / "train.csv"
    val_path = DATA_DIR / "val.csv"
    test_path = DATA_DIR / "test.csv"
    
    if not train_path.exists():
        from datasets.weather_prediction.generate_demo_data import generate_weather_dataset
        generate_weather_dataset()
        
    train_df = pd.read_csv(train_path)
    val_df = pd.read_csv(val_path)
    test_df = pd.read_csv(test_path)
    
    print(f"Loaded {len(train_df)} train, {len(val_df)} val, {len(test_df)} test chronological observations.")
    
    X_train = train_df[FEATURE_COLUMNS].values
    y_train = train_df[TARGET_COLUMN].values
    
    X_val = val_df[FEATURE_COLUMNS].values
    y_val = val_df[TARGET_COLUMN].values
    
    X_test = test_df[FEATURE_COLUMNS].values
    y_test = test_df[TARGET_COLUMN].values
    
    # Feature scaler
    scaler = StandardScaler()
    X_train_scaled = scaler.fit_transform(X_train)
    X_val_scaled = scaler.transform(X_val)
    X_test_scaled = scaler.transform(X_test)
    
    # Random Forest Regressor
    model = RandomForestRegressor(
        n_estimators=120,
        max_depth=12,
        min_samples_split=4,
        random_state=42,
        n_jobs=-1
    )
    model.fit(X_train_scaled, y_train)
    
    # Validation evaluation
    val_preds = model.predict(X_val_scaled)
    val_mae = mean_absolute_error(y_val, val_preds)
    val_rmse = np.sqrt(mean_squared_error(y_val, val_preds))
    val_r2 = r2_score(y_val, val_preds)
    
    # Test evaluation (chronological held-out)
    test_preds = model.predict(X_test_scaled)
    test_mae = mean_absolute_error(y_test, test_preds)
    test_rmse = np.sqrt(mean_squared_error(y_test, test_preds))
    test_r2 = r2_score(y_test, test_preds)
    
    # Feature importances
    importances = dict(zip(FEATURE_COLUMNS, [round(float(v), 4) for v in model.feature_importances_]))
    sorted_importances = dict(sorted(importances.items(), key=lambda item: item[1], reverse=True))
    
    # Save model bundle
    bundle = {
        "model_type": "RandomForestRegressor",
        "model": model,
        "scaler": scaler,
        "features": FEATURE_COLUMNS,
        "target": TARGET_COLUMN,
        "framework": "scikit-learn",
        "n_features": len(FEATURE_COLUMNS),
    }
    model_file = MODEL_DIR / "weather_predictor.joblib"
    joblib.dump(bundle, model_file)
    print(f"Saved trained weather model bundle to {model_file}")
    
    # Evaluation report metadata
    eval_report = {
        "model_name": "Random Forest Temperature Forecaster v1.0",
        "dataset_source": "Open-Meteo Historical Weather Observations",
        "split_method": "Chronological (Zero lookahead data leakage)",
        "train_samples": len(train_df),
        "val_samples": len(val_df),
        "test_samples": len(test_df),
        "metrics": {
            "test_mae": round(float(test_mae), 2),
            "test_rmse": round(float(test_rmse), 2),
            "test_r2": round(float(test_r2), 4),
            "val_mae": round(float(val_mae), 2),
            "val_rmse": round(float(val_rmse), 2),
            "val_r2": round(float(val_r2), 4)
        },
        "top_features": list(sorted_importances.keys())[:5],
        "feature_importances": sorted_importances,
        "sample_predictions": [
            {
                "date": test_df.iloc[i]["date"],
                "actual_next_day_temp": round(float(y_test[i]), 1),
                "predicted_next_day_temp": round(float(test_preds[i]), 1),
                "error": round(float(abs(y_test[i] - test_preds[i])), 2)
            }
            for i in range(min(5, len(test_df)))
        ]
    }
    
    eval_file = MODEL_DIR / "weather_predictor_eval.json"
    with open(eval_file, "w", encoding="utf-8") as f:
        json.dump(eval_report, f, indent=2)
        
    print("\n[Chronological Test Set Evaluation]")
    print(f"• Mean Absolute Error (MAE): {eval_report['metrics']['test_mae']} °C")
    print(f"• Root Mean Squared Error (RMSE): {eval_report['metrics']['test_rmse']} °C")
    print(f"• Coefficient of Determination (R²): {eval_report['metrics']['test_r2']:.4f}")
    print(f"Evaluation report saved to {eval_file}")
    
    return eval_report

if __name__ == "__main__":
    train_weather_predictor()
