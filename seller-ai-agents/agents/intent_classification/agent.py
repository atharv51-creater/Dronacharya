"""
agent.py
Independent Service Implementation for Agent 4: Text Intent Classification & Marketplace Service Router (CogniRoute).
Loads model/intent_classifier.joblib, determines request intent, handles out-of-scope queries,
and provides recommended marketplace service routing without bypassing buyer purchase logic.
"""

import time
from pathlib import Path
import joblib
import numpy as np

CURRENT_DIR = Path(__file__).resolve().parent
MODEL_PATH = CURRENT_DIR / "model" / "intent_classifier.joblib"
EVAL_PATH = CURRENT_DIR / "model" / "intent_classifier_eval.json"

_MODEL_CACHE = None

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


def load_model():
    global _MODEL_CACHE
    if _MODEL_CACHE is not None:
        return _MODEL_CACHE

    if not MODEL_PATH.exists():
        from train import train_intent_classifier
        train_intent_classifier()

    _MODEL_CACHE = joblib.load(MODEL_PATH)
    return _MODEL_CACHE


def classify_intent(query_text: str):
    start_time = time.perf_counter()

    if not query_text or not isinstance(query_text, str) or len(query_text.strip()) < 3:
        return {
            "query": query_text or "",
            "predicted_intent": "out_of_scope",
            "is_supported": False,
            "confidence": 0.0,
            "confidence_percentage": "0.0%",
            "confidence_threshold": 0.30,
            "recommended_service": None,
            "recommended_service_title": "Unsupported Out-Of-Scope Query",
            "routing_description": "Input query is empty or too short.",
            "alternative_intents": [],
            "latency_ms": round((time.perf_counter() - start_time) * 1000, 2),
            "model_status": "trained_and_ready",
            "model_type": "TF-IDF + LogisticRegression + OOS Thresholding",
            "dataset_source": "CLINC150 / OOS-Eval Benchmark"
        }

    try:
        bundle = load_model()
    except Exception as e:
        return {
            "error": f"Model loading failed: {str(e)}",
            "status": "model_error"
        }

    vectorizer = bundle["vectorizer"]
    clf = bundle["classifier"]
    if "classes" in bundle:
        classes = bundle["classes"]
        idx_to_intent = {i: c for i, c in enumerate(classes)}
    else:
        idx_to_intent = bundle.get("idx_to_intent", {})
    threshold = bundle.get("confidence_threshold", bundle.get("oos_threshold", 0.30))

    vec = vectorizer.transform([query_text])
    probs = clf.predict_proba(vec)[0]

    top_idx = int(np.argmax(probs))
    top_prob = float(probs[top_idx])
    predicted_intent = idx_to_intent.get(top_idx, "out_of_scope")

    if top_prob < threshold or predicted_intent == "out_of_scope":
        final_intent = "out_of_scope"
        is_supported = False
    else:
        final_intent = predicted_intent
        is_supported = True

    sorted_indices = np.argsort(probs)[::-1]
    alternatives = [
        {"intent": idx_to_intent[idx], "confidence": round(float(probs[idx]), 4)}
        for idx in sorted_indices[:3]
    ]

    routing_info = SERVICE_ROUTING_MAP.get(final_intent, SERVICE_ROUTING_MAP["out_of_scope"])
    elapsed_ms = round((time.perf_counter() - start_time) * 1000, 2)

    return {
        "query": query_text,
        "predicted_intent": final_intent,
        "is_supported": is_supported,
        "confidence": round(top_prob, 4),
        "confidence_percentage": f"{round(top_prob * 100, 1)}%",
        "confidence_threshold": threshold,
        "recommended_service": routing_info["service_name"],
        "recommended_service_title": routing_info["service_title"],
        "routing_description": routing_info["description"],
        "alternative_intents": alternatives,
        "latency_ms": elapsed_ms,
        "model_status": "trained_and_ready",
        "model_type": bundle.get("model_type", "TF-IDF + LogisticRegression + OOS Thresholding"),
        "dataset_source": "CLINC150 / OOS-Eval Benchmark"
    }


class IntentClassifierAgent:
    def __init__(self):
        bundle = load_model()
        self.model = bundle.get("classifier")
        self.vectorizer = bundle.get("vectorizer")

    def classify(self, query_text: str):
        return classify_intent(query_text)
