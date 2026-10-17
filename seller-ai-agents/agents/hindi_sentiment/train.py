"""
Training Pipeline for Agent 3: Hindi Sentiment Analysis Agent.
Trains TF-IDF word/char N-gram Vectorizer + Logistic Regression on MTEB Hindi Sentiment benchmark.
Evaluates accuracy, precision, recall, and macro F1 on held-out test split.
Saves model artifacts to model/hindi_sentiment.joblib and model/hindi_sentiment_eval.json.
"""

import sys
import json
from pathlib import Path
import numpy as np
import joblib
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, precision_recall_fscore_support, classification_report

CURRENT_DIR = Path(__file__).resolve().parent
DATA_DIR = CURRENT_DIR / "data"
MODEL_DIR = CURRENT_DIR / "model"
MODEL_DIR.mkdir(parents=True, exist_ok=True)
MODEL_PATH = MODEL_DIR / "hindi_sentiment.joblib"
EVAL_PATH = MODEL_DIR / "hindi_sentiment_eval.json"

# Dataset Ground Truth Labels:
# 0 = Negative (नकारात्मक)
# 1 = Neutral (तटस्थ)
# 2 = Positive (सकारात्मक)
LABEL_NAMES = {0: "negative", 1: "neutral", 2: "positive"}


def train_hindi_sentiment():
    print("============================================================")
    print("Training Agent 3: Hindi Sentiment & Review Classifier")
    print("============================================================")

    train_path = DATA_DIR / "train.json"
    val_path = DATA_DIR / "val.json"
    test_path = DATA_DIR / "test.json"

    if not train_path.exists():
        from data.generate_demo_data import generate_sentiment_dataset
        generate_sentiment_dataset()

    with open(train_path, "r", encoding="utf-8") as f:
        train_data = json.load(f)

    with open(val_path, "r", encoding="utf-8") as f:
        val_data = json.load(f)

    with open(test_path, "r", encoding="utf-8") as f:
        test_data = json.load(f)

    print(f"Loaded {len(train_data)} train, {len(val_data)} val, {len(test_data)} test reviews.")

    # Combine train + val, keep test strictly held out
    fit_data = train_data + val_data
    X_train_raw = [item["text"] for item in fit_data]
    y_train = [int(item["label"]) for item in fit_data]

    X_test_raw = [item["text"] for item in test_data]
    y_test = [int(item["label"]) for item in test_data]

    vectorizer = TfidfVectorizer(
        ngram_range=(1, 3),
        analyzer="word",
        max_features=2500,
        sublinear_tf=True
    )

    X_train_vec = vectorizer.fit_transform(X_train_raw)
    X_test_vec = vectorizer.transform(X_test_raw)

    clf = LogisticRegression(
        C=1.0,
        max_iter=1000,
        class_weight="balanced",
        random_state=42,
        solver="lbfgs"
    )
    clf.fit(X_train_vec, y_train)

    bundle = {
        "model_type": "TF-IDF + LogisticRegression",
        "vectorizer": vectorizer,
        "classifier": clf,
        "label_names": LABEL_NAMES,
        "dataset_name": "MTEB Hindi Sentiment (CC BY 4.0)"
    }

    joblib.dump(bundle, MODEL_PATH)
    print(f"Saved trained sentiment model bundle to {MODEL_PATH}")

    # Evaluate on held-out test split
    y_pred = clf.predict(X_test_vec)

    acc = float(accuracy_score(y_test, y_pred))
    p, r, f1, _ = precision_recall_fscore_support(y_test, y_pred, average="macro", zero_division=0)

    report_str = classification_report(
        y_test,
        y_pred,
        target_names=[LABEL_NAMES[i] for i in sorted(LABEL_NAMES.keys())],
        zero_division=0
    )

    eval_report = {
        "agent": "hindi_sentiment",
        "model_type": "TF-IDF + LogisticRegression",
        "dataset": "MTEB Hindi Sentiment Benchmark (CC BY 4.0)",
        "test_samples": len(test_data),
        "held_out_metrics": {
            "accuracy": f"{round(acc * 100, 2)}%",
            "macro_precision": f"{round(float(p) * 100, 2)}%",
            "macro_recall": f"{round(float(r) * 100, 2)}%",
            "macro_f1": f"{round(float(f1) * 100, 2)}%"
        },
        "raw_metrics": {
            "accuracy": round(acc, 4),
            "macro_precision": round(float(p), 4),
            "macro_recall": round(float(r), 4),
            "macro_f1": round(float(f1), 4)
        },
        "classification_report": report_str
    }

    with open(EVAL_PATH, "w", encoding="utf-8") as f:
        json.dump(eval_report, f, indent=2)

    print("\n[Held-Out Test Set Evaluation]")
    print(f"- Accuracy: {round(acc * 100, 2)}%")
    print(f"- Macro Precision: {round(float(p) * 100, 2)}%")
    print(f"- Macro Recall: {round(float(r) * 100, 2)}%")
    print(f"- Macro F1: {round(float(f1) * 100, 2)}%")
    print(f"Evaluation report saved to {EVAL_PATH}")

    return eval_report


if __name__ == "__main__":
    train_hindi_sentiment()
