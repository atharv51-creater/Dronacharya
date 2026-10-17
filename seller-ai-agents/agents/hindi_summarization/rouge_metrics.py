"""
Self-contained ROUGE-1, ROUGE-2, and ROUGE-L Evaluation Utility for Devanagari Hindi Text.
Calculates token-level precision, recall, and F1 score with Longest Common Subsequence (LCS).
"""

import re


def tokenize_devanagari(text: str):
    """Splits Hindi text into clean Devanagari words/tokens."""
    clean = re.sub(r"[।\n?!.,;:\"'()\-]+", " ", str(text))
    return [w.strip() for w in clean.split() if w.strip()]


def get_ngrams(tokens, n=1):
    """Returns a list of n-grams from a token sequence."""
    if len(tokens) < n:
        return []
    return [tuple(tokens[i : i + n]) for i in range(len(tokens) - n + 1)]


def compute_ngram_rouge(hyp_tokens, ref_tokens, n=1):
    """Computes ROUGE-N precision, recall, and F1."""
    hyp_ngrams = get_ngrams(hyp_tokens, n)
    ref_ngrams = get_ngrams(ref_tokens, n)

    if not hyp_ngrams or not ref_ngrams:
        return {"precision": 0.0, "recall": 0.0, "f1": 0.0}

    ref_counts = {}
    for ng in ref_ngrams:
        ref_counts[ng] = ref_counts.get(ng, 0) + 1

    overlap = 0
    hyp_counts = {}
    for ng in hyp_ngrams:
        hyp_counts[ng] = hyp_counts.get(ng, 0) + 1

    for ng, count in hyp_counts.items():
        overlap += min(count, ref_counts.get(ng, 0))

    precision = overlap / len(hyp_ngrams) if len(hyp_ngrams) > 0 else 0.0
    recall = overlap / len(ref_ngrams) if len(ref_ngrams) > 0 else 0.0
    f1 = (2 * precision * recall) / (precision + recall) if (precision + recall) > 0 else 0.0

    return {"precision": round(precision, 4), "recall": round(recall, 4), "f1": round(f1, 4)}


def lcs_length(seq1, seq2):
    """Computes the length of the Longest Common Subsequence (LCS) between two token sequences."""
    m, n = len(seq1), len(seq2)
    if m == 0 or n == 0:
        return 0

    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m):
        for j in range(n):
            if seq1[i] == seq2[j]:
                dp[i + 1][j + 1] = dp[i][j] + 1
            else:
                dp[i + 1][j + 1] = max(dp[i + 1][j], dp[i][j + 1])
    return dp[m][n]


def compute_rouge_l(hyp_tokens, ref_tokens):
    """Computes ROUGE-L precision, recall, and F1 based on LCS."""
    if not hyp_tokens or not ref_tokens:
        return {"precision": 0.0, "recall": 0.0, "f1": 0.0}

    lcs_val = lcs_length(hyp_tokens, ref_tokens)
    precision = lcs_val / len(hyp_tokens) if len(hyp_tokens) > 0 else 0.0
    recall = lcs_val / len(ref_tokens) if len(ref_tokens) > 0 else 0.0
    f1 = (2 * precision * recall) / (precision + recall) if (precision + recall) > 0 else 0.0

    return {"precision": round(precision, 4), "recall": round(recall, 4), "f1": round(f1, 4)}


def compute_all_rouge(hypothesis_text: str, reference_text: str):
    """Computes ROUGE-1, ROUGE-2, and ROUGE-L between a generated summary and gold reference."""
    hyp_tokens = tokenize_devanagari(hypothesis_text)
    ref_tokens = tokenize_devanagari(reference_text)

    r1 = compute_ngram_rouge(hyp_tokens, ref_tokens, n=1)
    r2 = compute_ngram_rouge(hyp_tokens, ref_tokens, n=2)
    rl = compute_rouge_l(hyp_tokens, ref_tokens)

    return {
        "rouge1": r1,
        "rouge2": r2,
        "rougeL": rl,
        "hyp_tokens_count": len(hyp_tokens),
        "ref_tokens_count": len(ref_tokens),
    }
