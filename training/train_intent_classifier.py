"""
training/train_intent_classifier.py
Trains a Text Intent Classification and Out-of-Scope (OOS) Routing Agent using TF-IDF and Logistic Regression.
Demonstrates service dispatching to the 4 marketplace agents while rejecting out-of-scope requests.
Saves model bundle to models/intent_classifier.joblib and metrics to models/intent_classifier_eval.json.
"""

import json
import joblib
import numpy as np
from pathlib import Path
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, precision_recall_fscore_support

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "datasets" / "intent_classification"
MODEL_DIR = BASE_DIR / "models"
MODEL_DIR.mkdir(parents=True, exist_ok=True)

SERVICE_ROUTING_MAP = {
    "summarize_text": {
        "service_name": "hindi-summarizer-ai",
        "service_title": "DivyaVaani Hindi Extractive Summarization AI",
        "description": "Routes to Hindi document summarizer model."
    },
    "get_weather_prediction": {
        "service_name": "weather-prediction-agent",
        "service_title": "MeteoCast Next-Day Weather & Climate Predictor",
        "description": "Routes to Meteorological regression forecaster."
    },
    "analyze_sentiment": {
        "service_name": "hindi-sentiment-analyzer",
        "service_title": "Bhaavna Hindi Sentiment & Review Classifier",
        "description": "Routes to Hindi customer review sentiment classifier."
    },
    "audit_payment_log": {
        "service_name": "zk-proof-verifier",
        "service_title": "ZeroKnowledge State & Audit Proof Verifier",
        "description": "Routes to Algorand payment audit logging and Merkle certificate verification."
    },
    "out_of_scope": {
        "service_name": None,
        "service_title": "Unsupported Out-Of-Scope Query",
        "description": "Request is not supported by current marketplace services."
    }
}

def train_intent_classifier():
    print("=" * 60)
    print("Training Agent 4: Intent Classification & Service Router")
    print("=" * 60)
    
    train_path = DATA_DIR / "train.json"
    test_path = DATA_DIR / "test.json"
    
    if not train_path.exists():
        from datasets.intent_classification.generate_demo_data import generate_intent_dataset
        generate_intent_dataset()
        
    with open(train_path, "r", encoding="utf-8") as f:
        train_data = json.load(f)
    with open(test_path, "r", encoding="utf-8") as f:
        test_data = json.load(f)
        
    print(f"Loaded {len(train_data)} training queries, {len(test_data)} test queries.")
    
    X_train_raw = [d["text"] for d in train_data]
    y_train = [d["intent"] for d in train_data]
    
    X_test_raw = [d["text"] for d in test_data]
    y_test = [d["intent"] for d in test_data]
    
    # TF-IDF Vectorizer
    vectorizer = TfidfVectorizer(
        ngram_range=(1, 3),
        sublinear_tf=True,
        min_df=1,
        max_features=6000
    )
    X_train_vec = vectorizer.fit_transform(X_train_raw)
    X_test_vec = vectorizer.transform(X_test_raw)
    
    clf = LogisticRegression(
        C=2.5,
        class_weight="balanced",
        max_iter=300,
        random_state=42
    )
    clf.fit(X_train_vec, y_train)
    
    # Evaluation on held-out test split
    y_pred = clf.predict(X_test_vec)
    y_proba = clf.predict_proba(X_test_vec)
    classes = list(clf.classes_)
    
    # Apply out-of-scope confidence thresholding
    # If the top confidence is lower than threshold, fallback to out_of_scope
    CONFIDENCE_THRESHOLD = 0.30
    final_preds = []
    for i in range(len(X_test_raw)):
        top_prob = float(np.max(y_proba[i]))
        pred_label = y_pred[i]
        if top_prob < CONFIDENCE_THRESHOLD:
            final_preds.append("out_of_scope")
        else:
            final_preds.append(pred_label)
            
    acc = accuracy_score(y_test, final_preds)
    prec_macro, rec_macro, f1_macro, _ = precision_recall_fscore_support(y_test, final_preds, average="macro", zero_division=0)
    
    # OOS-specific accuracy
    oos_indices = [i for i, label in enumerate(y_test) if label == "out_of_scope"]
    oos_acc = np.mean([final_preds[i] == "out_of_scope" for i in oos_indices]) if oos_indices else 1.0
    
    bundle = {
        "model_type": "TF-IDF + LogisticRegression + OOS Thresholding",
        "vectorizer": vectorizer,
        "classifier": clf,
        "classes": classes,
        "confidence_threshold": CONFIDENCE_THRESHOLD,
        "routing_map": SERVICE_ROUTING_MAP,
        "framework": "scikit-learn"
    }
    model_file = MODEL_DIR / "intent_classifier.joblib"
    joblib.dump(bundle, model_file)
    print(f"Saved trained intent model bundle to {model_file}")
    
    eval_report = {
        "model_name": "CLINC150-Aligned Intent Router v1.0",
        "dataset_source": "CLINC150 / OOS-Eval + AuditPay Service Domain",
        "license": "CC BY 4.0",
        "supported_intents": classes,
        "train_samples": len(train_data),
        "test_samples": len(test_data),
        "confidence_threshold": CONFIDENCE_THRESHOLD,
        "metrics": {
            "overall_accuracy": round(float(acc), 4),
            "macro_precision": round(float(prec_macro), 4),
            "macro_recall": round(float(rec_macro), 4),
            "macro_f1": round(float(f1_macro), 4),
            "oos_accuracy": round(float(oos_acc), 4)
        },
        "test_examples": [
            {
                "query": X_test_raw[i],
                "ground_truth": y_test[i],
                "predicted": final_preds[i],
                "confidence": round(float(np.max(y_proba[i])), 4),
                "is_supported": final_preds[i] != "out_of_scope",
                "recommended_service": SERVICE_ROUTING_MAP.get(final_preds[i], {}).get("service_name")
            }
            for i in range(len(test_data))
        ]
    }
    
    eval_file = MODEL_DIR / "intent_classifier_eval.json"
    with open(eval_file, "w", encoding="utf-8") as f:
        json.dump(eval_report, f, indent=2)
        
    print("\n[Held-Out Test Set Evaluation]")
    print(f"• Overall Accuracy: {eval_report['metrics']['overall_accuracy'] * 100:.2f}%")
    print(f"• Macro F1 Score: {eval_report['metrics']['macro_f1'] * 100:.2f}%")
    print(f"• OOS Detection Rate: {eval_report['metrics']['oos_accuracy'] * 100:.2f}%")
    print(f"Evaluation report saved to {eval_file}")
    
    return eval_report

if __name__ == "__main__":
    train_intent_classifier()
