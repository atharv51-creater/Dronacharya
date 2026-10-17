"""
Training Pipeline for Agent 4: Text Intent Classification & Marketplace Service Router.
Trains TF-IDF Vectorizer + Logistic Regression with Out-of-Scope (OOS) confidence thresholding.
Evaluates in-scope accuracy, macro F1, and OOS detection rate on held-out test split.
Saves model artifacts to model/intent_classifier.joblib and model/intent_classifier_eval.json.
"""

import sys
import json
from pathlib import Path
import numpy as np
import joblib
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, precision_recall_fscore_support

CURRENT_DIR = Path(__file__).resolve().parent
DATA_DIR = CURRENT_DIR / "data"
MODEL_DIR = CURRENT_DIR / "model"
MODEL_DIR.mkdir(parents=True, exist_ok=True)
MODEL_PATH = MODEL_DIR / "intent_classifier.joblib"
EVAL_PATH = MODEL_DIR / "intent_classifier_eval.json"

OOS_INTENT = "out_of_scope"
OOS_CONFIDENCE_THRESHOLD = 0.30


def train_intent_classifier():
    print("============================================================")
    print("Training Agent 4: Intent Classification & Service Router")
    print("============================================================")

    train_path = DATA_DIR / "train.json"
    val_path = DATA_DIR / "val.json"
    test_path = DATA_DIR / "test.json"

    if not train_path.exists():
        from data.generate_demo_data import generate_intent_dataset
        generate_intent_dataset()

    with open(train_path, "r", encoding="utf-8") as f:
        train_data = json.load(f)

    with open(val_path, "r", encoding="utf-8") as f:
        val_data = json.load(f)

    with open(test_path, "r", encoding="utf-8") as f:
        test_data = json.load(f)

    print(f"Loaded {len(train_data)} training queries, {len(test_data)} test queries.")

    fit_data = train_data + val_data
    X_train_raw = [item["text"] for item in fit_data]
    y_train_raw = [item["intent"] for item in fit_data]

    X_test_raw = [item["text"] for item in test_data]
    y_test_raw = [item["intent"] for item in test_data]

    unique_intents = sorted(list(set(y_train_raw)))
    intent_to_idx = {name: i for i, name in enumerate(unique_intents)}
    idx_to_intent = {i: name for name, i in intent_to_idx.items()}

    y_train = [intent_to_idx[name] for name in y_train_raw]

    vectorizer = TfidfVectorizer(
        ngram_range=(1, 2),
        sublinear_tf=True,
        max_features=1200
    )
    X_train_vec = vectorizer.fit_transform(X_train_raw)
    X_test_vec = vectorizer.transform(X_test_raw)

    clf = LogisticRegression(
        C=1.5,
        class_weight="balanced",
        random_state=42,
        max_iter=1000
    )
    clf.fit(X_train_vec, y_train)

    bundle = {
        "model_type": "TF-IDF + LogisticRegression + OOS Thresholding",
        "vectorizer": vectorizer,
        "classifier": clf,
        "classes": unique_intents,
        "intent_to_idx": intent_to_idx,
        "idx_to_intent": idx_to_intent,
        "confidence_threshold": OOS_CONFIDENCE_THRESHOLD,
        "oos_threshold": OOS_CONFIDENCE_THRESHOLD,
        "dataset_name": "CLINC150 / OOS-Eval + AuditPay Service Domain"
    }

    joblib.dump(bundle, MODEL_PATH)
    print(f"Saved trained intent model bundle to {MODEL_PATH}")

    # Evaluate on held-out test split with OOS threshold logic
    preds = []
    oos_actual = []
    oos_predicted = []

    for idx, text in enumerate(X_test_raw):
        vec = X_test_vec[idx]
        probs = clf.predict_proba(vec)[0]
        top_idx = int(np.argmax(probs))
        top_prob = float(probs[top_idx])
        predicted_intent = idx_to_intent[top_idx]

        if top_prob < OOS_CONFIDENCE_THRESHOLD:
            final_intent = OOS_INTENT
        else:
            final_intent = predicted_intent

        preds.append(final_intent)

        actual_intent = y_test_raw[idx]
        is_actual_oos = actual_intent == OOS_INTENT
        is_pred_oos = final_intent == OOS_INTENT
        oos_actual.append(is_actual_oos)
        oos_predicted.append(is_pred_oos)

    acc = float(accuracy_score(y_test_raw, preds))
    p, r, f1, _ = precision_recall_fscore_support(y_test_raw, preds, average="macro", zero_division=0)

    oos_tp = sum(1 for a, p_ in zip(oos_actual, oos_predicted) if a and p_)
    oos_total = sum(1 for a in oos_actual if a)
    oos_rate = oos_tp / max(1, oos_total)

    eval_report = {
        "agent": "intent_classifier",
        "model_type": "TF-IDF + LogisticRegression + OOS Thresholding",
        "dataset": "CLINC150 / OOS-Eval + AuditPay Service Domain",
        "test_samples": len(test_data),
        "held_out_metrics": {
            "overall_accuracy": f"{round(acc * 100, 2)}%",
            "macro_f1": f"{round(float(f1) * 100, 2)}%",
            "oos_detection_precision": f"{round(oos_rate * 100, 2)}%"
        },
        "raw_metrics": {
            "overall_accuracy": round(acc, 4),
            "macro_f1": round(float(f1), 4),
            "oos_accuracy": round(oos_rate, 4)
        },
        "oos_threshold": OOS_CONFIDENCE_THRESHOLD,
        "classes": unique_intents
    }

    with open(EVAL_PATH, "w", encoding="utf-8") as f:
        json.dump(eval_report, f, indent=2)

    print("\n[Held-Out Test Set Evaluation]")
    print(f"- Overall Accuracy: {round(acc * 100, 2)}%")
    print(f"- Macro F1 Score: {round(float(f1) * 100, 2)}%")
    print(f"- OOS Detection Rate: {round(oos_rate * 100, 2)}%")
    print(f"Evaluation report saved to {EVAL_PATH}")

    return eval_report


if __name__ == "__main__":
    train_intent_classifier()
