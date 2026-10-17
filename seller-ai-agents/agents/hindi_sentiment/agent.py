"""
agent.py
Independent Service Implementation for Agent 3: Hindi Sentiment Analysis Agent (Bhaavna).
Loads model/hindi_sentiment.joblib and classifies Hindi reviews into positive, negative, or neutral.
"""

import time
from pathlib import Path
import joblib
import numpy as np

CURRENT_DIR = Path(__file__).resolve().parent
MODEL_PATH = CURRENT_DIR / "model" / "hindi_sentiment.joblib"
EVAL_PATH = CURRENT_DIR / "model" / "hindi_sentiment_eval.json"

_MODEL_CACHE = None

LABEL_MAP = {0: "negative", 1: "neutral", 2: "positive"}
LABEL_EMOJIS = {"positive": "😊", "negative": "😞", "neutral": "😐"}


def load_model():
    global _MODEL_CACHE
    if _MODEL_CACHE is not None:
        return _MODEL_CACHE

    if not MODEL_PATH.exists():
        from train import train_hindi_sentiment
        train_hindi_sentiment()

    _MODEL_CACHE = joblib.load(MODEL_PATH)
    return _MODEL_CACHE


def analyze_sentiment(text: str):
    start_time = time.perf_counter()

    if not text or not isinstance(text, str) or len(text.strip()) < 3:
        return {
            "text": text or "",
            "sentiment": "neutral",
            "predicted_sentiment": "neutral",
            "sentiment_label": 1,
            "emoji": "😐",
            "confidence": 0.3333,
            "confidence_percentage": "33.3%",
            "probabilities": {"negative": 0.3333, "neutral": 0.3334, "positive": 0.3333},
            "latency_ms": round((time.perf_counter() - start_time) * 1000, 2),
            "model_status": "trained_and_ready",
            "model_type": "TF-IDF + LogisticRegression",
            "dataset_source": "MTEB Hindi Sentiment Benchmark (CC BY 4.0)",
        }

    try:
        bundle = load_model()
    except Exception as e:
        return {
            "error": f"Model loading failed: {str(e)}",
            "status": "model_error",
        }

    vectorizer = bundle["vectorizer"]
    clf = bundle["classifier"]

    X_vec = vectorizer.transform([text])
    pred_idx = int(clf.predict(X_vec)[0])
    probabilities = clf.predict_proba(X_vec)[0]

    label_text = LABEL_MAP.get(pred_idx, "unknown")
    confidence = float(np.max(probabilities))

    prob_dict = {
        LABEL_MAP[i]: round(float(probabilities[i]), 4)
        for i in range(len(probabilities))
    }

    elapsed_ms = round((time.perf_counter() - start_time) * 1000, 2)

    return {
        "text": text,
        "sentiment": label_text,
        "predicted_sentiment": label_text,
        "sentiment_label": pred_idx,
        "emoji": LABEL_EMOJIS.get(label_text, ""),
        "confidence": round(confidence, 4),
        "confidence_percentage": f"{round(confidence * 100, 1)}%",
        "probabilities": prob_dict,
        "latency_ms": elapsed_ms,
        "model_status": "trained_and_ready",
        "model_type": bundle.get("model_type", "TF-IDF + LogisticRegression"),
        "dataset_source": "MTEB Hindi Sentiment Benchmark (CC BY 4.0)",
    }


analyze_hindi_sentiment = analyze_sentiment


class HindiSentimentAgent:
    def __init__(self):
        bundle = load_model()
        self.model = bundle.get("classifier")
        self.vectorizer = bundle.get("vectorizer")

    def analyze(self, text: str):
        return analyze_sentiment(text)
