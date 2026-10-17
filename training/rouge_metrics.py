"""
training/rouge_metrics.py
Pure Python implementation of ROUGE-1, ROUGE-2, and ROUGE-L (Longest Common Subsequence) metrics.
Works seamlessly on Devanagari (Hindi) and English text without external C/Java dependencies.
"""

import re
from collections import Counter

def tokenize_hindi(text):
    """Tokenizes text preserving Hindi Devanagari unicode words."""
    # Split on whitespace and punctuation
    tokens = re.findall(r"[\u0900-\u097F\w]+", text, re.UNICODE)
    return [t.lower() for t in tokens if t.strip()]

def get_ngrams(tokens, n):
    """Generates a list of n-grams from tokens."""
    if len(tokens) < n:
        return []
    return [tuple(tokens[i:i+n]) for i in range(len(tokens) - n + 1)]

def lcs_length(seq1, seq2):
    """Computes the length of the Longest Common Subsequence between two token sequences."""
    m, n = len(seq1), len(seq2)
    if m == 0 or n == 0:
        return 0
    # DP table optimized for O(min(m, n)) space
    if m < n:
        seq1, seq2 = seq2, seq1
        m, n = n, m
    dp = [0] * (n + 1)
    for i in range(1, m + 1):
        prev = 0
        for j in range(1, n + 1):
            temp = dp[j]
            if seq1[i - 1] == seq2[j - 1]:
                dp[j] = prev + 1
            else:
                dp[j] = max(dp[j], dp[j - 1])
            prev = temp
    return dp[n]

def compute_rouge_n(hypothesis, reference, n=1):
    """Computes ROUGE-N precision, recall, and F1."""
    hyp_tokens = tokenize_hindi(hypothesis)
    ref_tokens = tokenize_hindi(reference)
    
    hyp_ngrams = Counter(get_ngrams(hyp_tokens, n))
    ref_ngrams = Counter(get_ngrams(ref_tokens, n))
    
    if not ref_ngrams or not hyp_ngrams:
        return {"precision": 0.0, "recall": 0.0, "f1": 0.0}
    
    overlap = 0
    for ngram, count in hyp_ngrams.items():
        if ngram in ref_ngrams:
            overlap += min(count, ref_ngrams[ngram])
            
    recall = overlap / sum(ref_ngrams.values()) if ref_ngrams else 0.0
    precision = overlap / sum(hyp_ngrams.values()) if hyp_ngrams else 0.0
    
    if precision + recall > 0:
        f1 = (2 * precision * recall) / (precision + recall)
    else:
        f1 = 0.0
        
    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4)
    }

def compute_rouge_l(hypothesis, reference):
    """Computes ROUGE-L (LCS) precision, recall, and F1."""
    hyp_tokens = tokenize_hindi(hypothesis)
    ref_tokens = tokenize_hindi(reference)
    
    if not ref_tokens or not hyp_tokens:
        return {"precision": 0.0, "recall": 0.0, "f1": 0.0}
        
    lcs = lcs_length(hyp_tokens, ref_tokens)
    recall = lcs / len(ref_tokens)
    precision = lcs / len(hyp_tokens)
    
    if precision + recall > 0:
        f1 = (2 * precision * recall) / (precision + recall)
    else:
        f1 = 0.0
        
    return {
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4)
    }

def compute_all_rouge(hypothesis, reference):
    """Computes ROUGE-1, ROUGE-2, and ROUGE-L."""
    return {
        "rouge1": compute_rouge_n(hypothesis, reference, n=1),
        "rouge2": compute_rouge_n(hypothesis, reference, n=2),
        "rougeL": compute_rouge_l(hypothesis, reference)
    }
