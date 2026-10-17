"""
training/train_hindi_summarizer.py
Trains an extractive Hindi summarization sentence-ranking model on CPU.
Uses TF-IDF, positional signals, sentence length, and centroid similarity.
Saves model to models/hindi_summarizer.joblib and evaluation metrics to models/hindi_summarizer_eval.json.
"""

import os
import re
import json
import joblib
import numpy as np
from pathlib import Path
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics.pairwise import cosine_similarity
from rouge_metrics import compute_all_rouge

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "datasets" / "hindi_summarization"
MODEL_DIR = BASE_DIR / "models"
MODEL_DIR.mkdir(parents=True, exist_ok=True)

def split_hindi_sentences(text):
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
    
    # Fit or transform TF-IDF
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
        word_count = len(words) / 50.0  # Normalized around typical ~50 words
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
        from datasets.hindi_summarization.generate_demo_data import generate_datasets
        generate_datasets()
        
    with open(train_path, "r", encoding="utf-8") as f:
        train_data = json.load(f)
    with open(test_path, "r", encoding="utf-8") as f:
        test_data = json.load(f)
        
    print(f"Loaded {len(train_data)} training articles, {len(test_data)} test articles.")
    
    # Build vocabulary on all training articles and summaries
    all_texts = [d["article"] for d in train_data] + [d.get("summary", "") for d in train_data]
    vectorizer = TfidfVectorizer(
        ngram_range=(1, 2),
        min_df=1,
        max_features=5000,
        sublinear_tf=True
    )
    vectorizer.fit(all_texts)
    
    X_train_list = []
    y_train_list = []
    
    for item in train_data:
        article = item["article"]
        ref_summary = item.get("summary", "")
        title = item.get("title", "")
        sentences = split_hindi_sentences(article)
        if not sentences:
            continue
            
        feats = extract_sentence_features(sentences, article, title, vectorizer)
        
        # Oracle labeling: compute ROUGE-L overlap of each sentence with reference summary
        scores = []
        for s in sentences:
            r = compute_all_rouge(s, ref_summary)
            scores.append(r["rougeL"]["f1"])
            
        # Top 2 sentences with highest overlap are positive labels (1), others negative (0)
        top_indices = np.argsort(scores)[-2:] if len(scores) >= 2 else np.arange(len(scores))
        labels = np.zeros(len(sentences), dtype=int)
        labels[top_indices] = 1
        
        X_train_list.append(feats)
        y_train_list.append(labels)
        
    X_train = np.vstack(X_train_list)
    y_train = np.concatenate(y_train_list)
    
    # Train Logistic Regression sentence ranker
    clf = LogisticRegression(class_weight="balanced", random_state=42, max_iter=200)
    clf.fit(X_train, y_train)
    
    print(f"Classifier trained on {len(X_train)} sentence instances across {len(train_data)} articles.")
    
    # Save model artifacts
    bundle = {
        "model_type": "extractive_sentence_ranker",
        "classifier": clf,
        "vectorizer": vectorizer,
        "feature_names": ["relative_position", "is_first_sentence", "word_count_norm", "centroid_similarity", "title_similarity"],
        "max_sentences": 2,
        "framework": "scikit-learn",
        "language": "hi",
    }
    model_file = MODEL_DIR / "hindi_summarizer.joblib"
    joblib.dump(bundle, model_file)
    print(f"Saved trained model bundle to {model_file}")
    
    # Evaluation on Held-Out Test Set
    eval_results = []
    rouge1_f1s = []
    rouge2_f1s = []
    rougeL_f1s = []
    compression_ratios = []
    
    for item in test_data:
        article = item["article"]
        ref_summary = item["summary"]
        title = item.get("title", "")
        sentences = split_hindi_sentences(article)
        if not sentences:
            continue
            
        feats = extract_sentence_features(sentences, article, title, vectorizer)
        # Probability of being an informative summary sentence
        probs = clf.predict_proba(feats)[:, 1] if hasattr(clf, "predict_proba") else clf.decision_function(feats)
        
        # Pick top 2 sentences while preserving chronological document order
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
        comp_ratio = round((1.0 - (sum_len / max(1, orig_len))) * 100, 1)
        compression_ratios.append(comp_ratio)
        
        eval_results.append({
            "id": item.get("id"),
            "title": title,
            "generated_summary": generated_summary,
            "reference_summary": ref_summary,
            "compression_ratio": comp_ratio,
            "rouge": metrics
        })
        
    avg_eval = {
        "model_name": "Hindi Extractive Summarizer v1.0",
        "dataset": "XL-Sum Hindi (Held-out Test Split)",
        "num_test_samples": len(test_data),
        "mean_rouge1_f1": round(float(np.mean(rouge1_f1s)), 4),
        "mean_rouge2_f1": round(float(np.mean(rouge2_f1s)), 4),
        "mean_rougeL_f1": round(float(np.mean(rougeL_f1s)), 4),
        "mean_compression_ratio_pct": round(float(np.mean(compression_ratios)), 1),
        "eval_timestamp": str(np.datetime64("now")),
        "test_examples": eval_results
    }
    
    eval_file = MODEL_DIR / "hindi_summarizer_eval.json"
    with open(eval_file, "w", encoding="utf-8") as f:
        json.dump(avg_eval, f, ensure_ascii=False, indent=2)
        
    print("\n[Evaluation on Held-Out Test Split]")
    print(f"• ROUGE-1 F1: {avg_eval['mean_rouge1_f1'] * 100:.2f}%")
    print(f"• ROUGE-2 F1: {avg_eval['mean_rouge2_f1'] * 100:.2f}%")
    print(f"• ROUGE-L F1: {avg_eval['mean_rougeL_f1'] * 100:.2f}%")
    print(f"• Avg Compression: {avg_eval['mean_compression_ratio_pct']}% reduction")
    print(f"Evaluation report saved to {eval_file}")
    
    return avg_eval

if __name__ == "__main__":
    train_hindi_summarizer()
