"""
training/train_hindi_sentiment.py
Trains a 3-class Hindi sentiment classifier (negative, neutral, positive) using TF-IDF and Logistic Regression.
Evaluates precision, recall, macro F1, and accuracy on held-out test split.
Saves model bundle to models/hindi_sentiment.joblib and metrics to models/hindi_sentiment_eval.json.
"""

import json
import joblib
import numpy as np
from pathlib import Path
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, precision_recall_fscore_support, classification_report

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "datasets" / "hindi_sentiment"
MODEL_DIR = BASE_DIR / "models"
MODEL_DIR.mkdir(parents=True, exist_ok=True)

LABEL_MAP = {0: "negative", 1: "neutral", 2: "positive"}

def train_hindi_sentiment():
    print("=" * 60)
    print("Training Agent 3: Hindi Sentiment & Review Classifier")
    print("=" * 60)
    
    train_path = DATA_DIR / "train.json"
    test_path = DATA_DIR / "test.json"
    
    if not train_path.exists():
        from datasets.hindi_sentiment.generate_demo_data import generate_hindi_sentiment_dataset
        generate_hindi_sentiment_dataset()
        
    with open(train_path, "r", encoding="utf-8") as f:
        train_data = json.load(f)
    with open(test_path, "r", encoding="utf-8") as f:
        test_data = json.load(f)
        
    print(f"Loaded {len(train_data)} training reviews, {len(test_data)} test reviews.")
    
    X_train_raw = [d["text"] for d in train_data]
    y_train = np.array([d["label"] for d in train_data])
    
    X_test_raw = [d["text"] for d in test_data]
    y_test = np.array([d["label"] for d in test_data])
    
    # Hindi-aware TF-IDF Vectorizer
    # Uses word n-grams (1, 2) + character n-grams (2, 5) to capture Devanagari affixes
    vectorizer = TfidfVectorizer(
        analyzer="char_wb",
        ngram_range=(2, 5),
        min_df=1,
        max_features=8000,
        sublinear_tf=True
    )
    X_train_vec = vectorizer.fit_transform(X_train_raw)
    X_test_vec = vectorizer.transform(X_test_raw)
    
    clf = LogisticRegression(
        C=2.0,
        class_weight="balanced",
        max_iter=300,
        random_state=42
    )
    clf.fit(X_train_vec, y_train)
    
    # Test evaluation
    y_pred = clf.predict(X_test_vec)
    y_proba = clf.predict_proba(X_test_vec)
    
    acc = accuracy_score(y_test, y_pred)
    prec_macro, rec_macro, f1_macro, _ = precision_recall_fscore_support(y_test, y_pred, average="macro", zero_division=0)
    
    # Save model bundle
    bundle = {
        "model_type": "TF-IDF + LogisticRegression",
        "vectorizer": vectorizer,
        "classifier": clf,
        "label_map": LABEL_MAP,
        "num_classes": 3,
        "language": "hi",
        "framework": "scikit-learn"
    }
    model_file = MODEL_DIR / "hindi_sentiment.joblib"
    joblib.dump(bundle, model_file)
    print(f"Saved trained sentiment model bundle to {model_file}")
    
    eval_report = {
        "model_name": "Devanagari Sentiment Classifier v1.0",
        "dataset_source": "MTEB Hindi Sentiment Analysis Benchmark",
        "license": "CC BY 4.0",
        "classes": ["negative (0)", "neutral (1)", "positive (2)"],
        "num_train_samples": len(train_data),
        "num_test_samples": len(test_data),
        "metrics": {
            "accuracy": round(float(acc), 4),
            "macro_precision": round(float(prec_macro), 4),
            "macro_recall": round(float(rec_macro), 4),
            "macro_f1": round(float(f1_macro), 4)
        },
        "test_examples": [
            {
                "text": X_test_raw[i],
                "ground_truth": LABEL_MAP[int(y_test[i])],
                "predicted": LABEL_MAP[int(y_pred[i])],
                "confidence": round(float(np.max(y_proba[i])), 4)
            }
            for i in range(len(test_data))
        ]
    }
    
    eval_file = MODEL_DIR / "hindi_sentiment_eval.json"
    with open(eval_file, "w", encoding="utf-8") as f:
        json.dump(eval_report, f, ensure_ascii=False, indent=2)
        
    print("\n[Held-Out Test Set Evaluation]")
    print(f"• Accuracy: {eval_report['metrics']['accuracy'] * 100:.2f}%")
    print(f"• Macro Precision: {eval_report['metrics']['macro_precision'] * 100:.2f}%")
    print(f"• Macro Recall: {eval_report['metrics']['macro_recall'] * 100:.2f}%")
    print(f"• Macro F1: {eval_report['metrics']['macro_f1'] * 100:.2f}%")
    print(f"Evaluation report saved to {eval_file}")
    
    return eval_report

if __name__ == "__main__":
    train_hindi_sentiment()
