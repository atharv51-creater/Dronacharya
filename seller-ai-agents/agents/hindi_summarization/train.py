"""
seller-ai-agents/agents/hindi_summarization/train.py
Training Pipeline for Agent 1: Hindi Summarization Extractive Ranker.
Trains on XL-Sum Hindi training data and evaluates on held-out test data.
Saves model artifacts to model/hindi_summarizer.joblib and model/hindi_summarizer_eval.json.
"""

import os
import sys
import json
import re
from pathlib import Path
import numpy as np
import joblib
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics.pairwise import cosine_similarity

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from rouge_metrics import compute_all_rouge

DATA_DIR = CURRENT_DIR / "data"
MODEL_DIR = CURRENT_DIR / "model"
MODEL_DIR.mkdir(parents=True, exist_ok=True)
MODEL_PATH = MODEL_DIR / "hindi_summarizer.joblib"
EVAL_PATH = MODEL_DIR / "hindi_summarizer_eval.json"


def split_hindi_sentences(text: str):
    """Splits Hindi text on danda (।), exclamation, question mark, or newlines."""
    raw_sentences = re.split(r"[।\n?!]+", text)
    cleaned = [s.strip() for s in raw_sentences if len(s.strip()) > 10]
    return cleaned


def extract_sentence_features(sentences, article_text, title="", vectorizer=None):
    """
    Extracts numerical features for each sentence in an article:
    - Relative position (0.0 to 1.0)
    - Is first sentence (lead bias)
    - Normalized word count
    - Cosine similarity to document centroid
    - Cosine similarity to title (if title provided)
    """
    n_sents = len(sentences)
    if n_sents == 0:
        return np.zeros((0, 5))

    corpus = [article_text] + sentences
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


def train_hindi_summarizer():
    print("=" * 60)
    print("Training Agent 1: Hindi Summarization Extractive Ranker")
    print("=" * 60)

    train_path = DATA_DIR / "train.json"
    test_path = DATA_DIR / "test.json"

    if not train_path.exists():
        from data.generate_demo_data import generate_datasets
        generate_datasets()

    with open(train_path, "r", encoding="utf-8") as f:
        train_data = json.load(f)
    with open(test_path, "r", encoding="utf-8") as f:
        test_data = json.load(f)

    print(f"Loaded {len(train_data)} training articles, {len(test_data)} test articles.")

    all_texts = [d.get("article", d.get("text", "")) for d in train_data] + [
        d.get("summary", "") for d in train_data
    ]
    vectorizer = TfidfVectorizer(
        ngram_range=(1, 2),
        min_df=1,
        max_features=5000,
        sublinear_tf=True,
    )
    vectorizer.fit(all_texts)

    X_train_list = []
    y_train_list = []

    for item in train_data:
        article = item.get("article", item.get("text", ""))
        ref_summary = item.get("summary", "")
        title = item.get("title", "")
        sentences = split_hindi_sentences(article)
        if not sentences:
            continue

        feats = extract_sentence_features(sentences, article, title, vectorizer)

        scores = []
        for s in sentences:
            r = compute_all_rouge(s, ref_summary)
            scores.append(r["rougeL"]["f1"])

        top_indices = np.argsort(scores)[-2:] if len(scores) >= 2 else np.arange(len(scores))
        labels = np.zeros(len(sentences), dtype=int)
        labels[top_indices] = 1

        X_train_list.append(feats)
        y_train_list.append(labels)

    X_train = np.vstack(X_train_list)
    y_train = np.concatenate(y_train_list)

    print(f"Total sentence training samples: {len(y_train)}, Positive labels: {int(sum(y_train))}")

    clf = LogisticRegression(class_weight="balanced", max_iter=300, random_state=42)
    clf.fit(X_train, y_train)

    bundle = {
        "model_type": "extractive_sentence_ranker",
        "classifier": clf,
        "vectorizer": vectorizer,
        "feature_names": [
            "relative_position",
            "is_first_sentence",
            "word_count_norm",
            "centroid_similarity",
            "title_similarity",
        ],
        "max_sentences": 2,
        "framework": "scikit-learn",
        "language": "hi",
    }
    joblib.dump(bundle, MODEL_PATH)
    print(f"Saved trained model bundle to {MODEL_PATH}")

    # Evaluation on Held-Out Test Set
    rouge1_f1s = []
    rouge2_f1s = []
    rougeL_f1s = []
    compression_ratios = []

    for item in test_data:
        article = item.get("article", item.get("text", ""))
        ref_summary = item["summary"]
        title = item.get("title", "")
        sentences = split_hindi_sentences(article)
        if not sentences:
            continue

        feats = extract_sentence_features(sentences, article, title, vectorizer)
        probs = clf.predict_proba(feats)[:, 1] if hasattr(clf, "predict_proba") else clf.decision_function(feats)

        top_k = min(2, len(sentences))
        selected_idx = sorted(np.argsort(probs)[-top_k:])
        generated_summary = " ".join([sentences[i] for i in selected_idx])
        if not generated_summary.endswith("।"):
            generated_summary += "।"

        metrics = compute_all_rouge(generated_summary, ref_summary)
        rouge1_f1s.append(metrics["rouge1"]["f1"])
        rouge2_f1s.append(metrics["rouge2"]["f1"])
        rougeL_f1s.append(metrics["rougeL"]["f1"])

        orig_len = len(article)
        sum_len = len(generated_summary)
        compression = (1.0 - (sum_len / max(1, orig_len))) * 100.0
        compression_ratios.append(compression)

    eval_summary = {
        "model": "Extractive Hindi Sentence Ranker",
        "dataset": "XL-Sum Hindi (BBC World Service)",
        "test_articles": len(test_data),
        "mean_rouge1_f1": round(float(np.mean(rouge1_f1s)), 4) if rouge1_f1s else 0.0,
        "mean_rouge2_f1": round(float(np.mean(rouge2_f1s)), 4) if rouge2_f1s else 0.0,
        "mean_rougeL_f1": round(float(np.mean(rougeL_f1s)), 4) if rougeL_f1s else 0.0,
        "mean_compression_ratio_pct": round(float(np.mean(compression_ratios)), 2) if compression_ratios else 0.0,
    }

    with open(EVAL_PATH, "w", encoding="utf-8") as f:
        json.dump(eval_summary, f, indent=2, ensure_ascii=False)

    print("Test Evaluation Metrics:")
    for k, v in eval_summary.items():
        print(f"  {k}: {v}")

    return eval_summary


if __name__ == "__main__":
    train_hindi_summarizer()
