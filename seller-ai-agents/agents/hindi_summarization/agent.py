"""
seller-ai-agents/agents/hindi_summarization/agent.py
Independent Service Implementation for Agent 1: Hindi Summarization (DivyaVaani).
Loads trained model from model/hindi_summarizer.joblib and generates extractive summaries for Hindi text.
"""

import time
import json
import re
from pathlib import Path
import numpy as np
import joblib
from sklearn.metrics.pairwise import cosine_similarity

CURRENT_DIR = Path(__file__).resolve().parent
MODEL_DIR = CURRENT_DIR / "model"
MODEL_PATH = MODEL_DIR / "hindi_summarizer.joblib"
EVAL_PATH = MODEL_DIR / "hindi_summarizer_eval.json"

_MODEL_CACHE = None


def split_sentences(text: str):
    """Splits Hindi text by Devanagari danda (।) and standard punctuation."""
    if not text:
        return []
    raw = re.split(r"[।\n?!]+", text)
    cleaned = [s.strip() for s in raw if len(s.strip()) > 8]
    return cleaned


def extract_sentence_features(sentences, text, title="", vectorizer=None):
    """
    Extracts 5 sentence-level features matching the trained model:
    1. relative_position
    2. is_first_sentence
    3. word_count_norm
    4. centroid_similarity
    5. title_similarity
    """
    n_sents = len(sentences)
    if n_sents == 0:
        return np.zeros((0, 5))

    corpus = [text] + sentences
    tfidf_matrix = vectorizer.transform(corpus)
    doc_vec = tfidf_matrix[0]
    sent_vecs = tfidf_matrix[1:]

    doc_sims = cosine_similarity(sent_vecs, doc_vec).flatten()

    if title and title.strip():
        title_vec = vectorizer.transform([title])
        title_sims = cosine_similarity(sent_vecs, title_vec).flatten()
    else:
        title_sims = np.zeros(n_sents)

    features = []
    for i, s in enumerate(sentences):
        words = s.split()
        pos = i / max(1, n_sents - 1)
        is_first = 1.0 if i == 0 else 0.0
        word_count = len(words) / 50.0
        sim_doc = float(doc_sims[i])
        sim_title = float(title_sims[i])
        features.append([pos, is_first, word_count, sim_doc, sim_title])

    return np.array(features)


def load_model():
    """Loads and caches the model artifact."""
    global _MODEL_CACHE
    if _MODEL_CACHE is not None:
        return _MODEL_CACHE

    if not MODEL_PATH.exists():
        from agents.hindi_summarization.train import train_hindi_summarizer
        train_hindi_summarizer()

    _MODEL_CACHE = joblib.load(MODEL_PATH)
    return _MODEL_CACHE


def summarize(text: str, max_sentences: int = 2, title: str = "") -> dict:
    """
    Performs extractive Hindi text summarization using the trained ranking model.
    """
    start_time = time.perf_counter()

    if not text or not isinstance(text, str) or len(text.strip()) < 15:
        return {
            "summary": text or "",
            "original_length": len(text) if text else 0,
            "original_length_chars": len(text) if text else 0,
            "summary_length": len(text) if text else 0,
            "summary_length_chars": len(text) if text else 0,
            "compression_ratio": 0.0,
            "sentence_count_original": 0,
            "sentence_count_summary": 0,
            "selected_indices": [],
            "status": "invalid_input",
            "model_status": "trained_and_ready",
            "latency_ms": round((time.perf_counter() - start_time) * 1000, 2),
        }

    try:
        bundle = load_model()
    except Exception as e:
        return {
            "error": f"Model loading failed: {str(e)}",
            "status": "model_error",
        }

    clf = bundle["classifier"]
    vectorizer = bundle["vectorizer"]

    sentences = split_sentences(text)
    if len(sentences) == 0:
        short_summary = text.strip()[:150] + ("..." if len(text) > 150 else "")
        return {
            "summary": short_summary,
            "original_length": len(text),
            "original_length_chars": len(text),
            "summary_length": len(short_summary),
            "summary_length_chars": len(short_summary),
            "compression_ratio": 0.0,
            "sentence_count_original": 1,
            "sentence_count_summary": 1,
            "selected_indices": [0],
            "latency_ms": round((time.perf_counter() - start_time) * 1000, 2),
            "model_status": "fallback_short_text",
            "dataset_source": "XL-Sum Hindi",
        }

    if len(sentences) <= max_sentences:
        sum_text = " ".join(sentences)
        if not sum_text.endswith("।"):
            sum_text += "।"
        elapsed_ms = round((time.perf_counter() - start_time) * 1000, 2)
        comp = round((1.0 - (len(sum_text) / max(1, len(text)))) * 100, 1)
        return {
            "summary": sum_text,
            "original_length": len(text),
            "original_length_chars": len(text),
            "summary_length": len(sum_text),
            "summary_length_chars": len(sum_text),
            "compression_ratio": max(0.0, comp),
            "sentence_count_original": len(sentences),
            "sentence_count_summary": len(sentences),
            "selected_indices": list(range(len(sentences))),
            "latency_ms": elapsed_ms,
            "model_status": "trained_and_ready",
            "model_type": bundle.get("model_type", "extractive_sentence_ranker"),
            "dataset_source": "XL-Sum Hindi",
        }

    # Extract 5 numerical features per sentence
    X = extract_sentence_features(sentences, text, title=title, vectorizer=vectorizer)
    probs = clf.predict_proba(X)[:, 1] if hasattr(clf, "predict_proba") else clf.decision_function(X)

    k = min(max_sentences, len(sentences))
    top_indices = sorted(np.argsort(probs)[-k:])
    selected_sentences = [sentences[i] for i in top_indices]

    summary = " ".join(selected_sentences)
    if not summary.endswith("।"):
        summary += "।"

    orig_len = len(text)
    sum_len = len(summary)
    compression = round((1.0 - (sum_len / max(1, orig_len))) * 100, 1)
    elapsed_ms = round((time.perf_counter() - start_time) * 1000, 2)

    return {
        "summary": summary,
        "original_length": orig_len,
        "original_length_chars": orig_len,
        "summary_length": sum_len,
        "summary_length_chars": sum_len,
        "compression_ratio": max(0.0, compression),
        "sentence_count_original": len(sentences),
        "sentence_count_summary": len(selected_sentences),
        "selected_indices": [int(idx) for idx in top_indices],
        "latency_ms": elapsed_ms,
        "model_status": "trained_and_ready",
        "model_type": bundle.get("model_type", "extractive_sentence_ranker"),
        "dataset_source": "XL-Sum Hindi",
    }


# Backwards compatibility alias
summarize_hindi = summarize


class HindiSummarizerAgent:
    def __init__(self):
        self.model_artifact = load_model()

    def summarize(self, text: str, max_sentences: int = 2, title: str = "") -> dict:
        return summarize(text, max_sentences=max_sentences, title=title)
