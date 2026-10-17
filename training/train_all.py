"""
training/train_all.py
Master Training and Evaluation Pipeline for all Four Seller-Side AI Agents.
Trains:
1. Agent 1: Hindi Summarization Extractive Ranker (ROUGE-1, ROUGE-2, ROUGE-L)
2. Agent 2: Next-Day Weather Regressor (MAE, RMSE, R²)
3. Agent 3: Hindi Sentiment Classifier (Accuracy, Precision, Recall, Macro F1)
4. Agent 4: Intent & OOS Service Router (Accuracy, Macro F1, OOS Detection Rate)

Reports individual failures gracefully and produces models/evaluation_metrics.json.
"""

import sys
import json
import traceback
from pathlib import Path
from datetime import datetime

BASE_DIR = Path(__file__).resolve().parent.parent
MODEL_DIR = BASE_DIR / "models"
MODEL_DIR.mkdir(parents=True, exist_ok=True)

# Add training folder to sys.path so rouge_metrics can be imported cleanly
sys.path.insert(0, str(Path(__file__).resolve().parent))

from train_hindi_summarizer import train_hindi_summarizer
from train_weather_predictor import train_weather_predictor
from train_hindi_sentiment import train_hindi_sentiment
from train_intent_classifier import train_intent_classifier

def run_master_training():
    print("#" * 70)
    print("AUDITPAY SELLER AI AGENTS - MASTER TRAINING & EVALUATION PIPELINE")
    print(f"Timestamp: {datetime.now().isoformat()}")
    print("#" * 70)
    
    results = {}
    failures = {}
    
    # --- Agent 1: Hindi Summarization ---
    try:
        res1 = train_hindi_summarizer()
        results["hindi_summarizer"] = {
            "status": "success",
            "model_type": "extractive_sentence_ranker",
            "metrics": {
                "rouge1_f1": res1["mean_rouge1_f1"],
                "rouge2_f1": res1["mean_rouge2_f1"],
                "rougeL_f1": res1["mean_rougeL_f1"],
                "compression_ratio_pct": res1["mean_compression_ratio_pct"]
            },
            "dataset": res1["dataset"],
            "test_samples": res1["num_test_samples"]
        }
    except Exception as e:
        print(f"\n[FAIL] Agent 1 training failed: {e}")
        traceback.print_exc()
        failures["hindi_summarizer"] = str(e)
        results["hindi_summarizer"] = {"status": "failed", "error": str(e)}

    # --- Agent 2: Weather Prediction ---
    try:
        res2 = train_weather_predictor()
        results["weather_predictor"] = {
            "status": "success",
            "model_type": "RandomForestRegressor",
            "metrics": {
                "test_mae": res2["metrics"]["test_mae"],
                "test_rmse": res2["metrics"]["test_rmse"],
                "test_r2": res2["metrics"]["test_r2"]
            },
            "dataset": res2["dataset_source"],
            "test_samples": res2["test_samples"]
        }
    except Exception as e:
        print(f"\n[FAIL] Agent 2 training failed: {e}")
        traceback.print_exc()
        failures["weather_predictor"] = str(e)
        results["weather_predictor"] = {"status": "failed", "error": str(e)}

    # --- Agent 3: Hindi Sentiment Analysis ---
    try:
        res3 = train_hindi_sentiment()
        results["hindi_sentiment"] = {
            "status": "success",
            "model_type": "TF-IDF + LogisticRegression",
            "metrics": {
                "accuracy": res3["metrics"]["accuracy"],
                "macro_precision": res3["metrics"]["macro_precision"],
                "macro_recall": res3["metrics"]["macro_recall"],
                "macro_f1": res3["metrics"]["macro_f1"]
            },
            "dataset": res3["dataset_source"],
            "test_samples": res3["num_test_samples"]
        }
    except Exception as e:
        print(f"\n[FAIL] Agent 3 training failed: {e}")
        traceback.print_exc()
        failures["hindi_sentiment"] = str(e)
        results["hindi_sentiment"] = {"status": "failed", "error": str(e)}

    # --- Agent 4: Intent Classification ---
    try:
        res4 = train_intent_classifier()
        results["intent_classifier"] = {
            "status": "success",
            "model_type": "TF-IDF + LogisticRegression + OOS Thresholding",
            "metrics": {
                "overall_accuracy": res4["metrics"]["overall_accuracy"],
                "macro_f1": res4["metrics"]["macro_f1"],
                "oos_accuracy": res4["metrics"]["oos_accuracy"]
            },
            "dataset": res4["dataset_source"],
            "test_samples": res4["test_samples"]
        }
    except Exception as e:
        print(f"\n[FAIL] Agent 4 training failed: {e}")
        traceback.print_exc()
        failures["intent_classifier"] = str(e)
        results["intent_classifier"] = {"status": "failed", "error": str(e)}

    # Write Master Evaluation Summary
    master_report = {
        "pipeline_version": "1.0.0",
        "timestamp": datetime.now().isoformat(),
        "total_agents": 4,
        "successful_agents": len([r for r in results.values() if r.get("status") == "success"]),
        "failed_agents": len(failures),
        "agents": results
    }
    
    summary_path = MODEL_DIR / "evaluation_metrics.json"
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump(master_report, f, indent=2)
        
    print("\n" + "=" * 70)
    print("MASTER TRAINING COMPLETE")
    print(f"Success: {master_report['successful_agents']}/4 Agents | Failures: {len(failures)}")
    print(f"Master evaluation metrics saved to {summary_path}")
    print("=" * 70)
    
    return master_report

if __name__ == "__main__":
    report = run_master_training()
    if report["failed_agents"] > 0:
        sys.exit(1)
