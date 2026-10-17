# Agent 1: DivyaVaani Hindi Extractive Summarization AI

A standalone, lightweight, CPU-optimized Hindi extractive summarization service.

## Overview
- **Service Name**: `hindi-summarizer-ai` (DivyaVaani)
- **Model Type**: Extractive Sentence Ranker (TF-IDF + Centroid Cosine Similarity + Learned Importance)
- **Dataset**: [XL-Sum Hindi Benchmark](https://huggingface.co/datasets/csebuetnlp/xlsum) (CC BY-NC-SA 4.0)
- **Held-Out Evaluation**:
  - ROUGE-1 F1: **24.93%**
  - ROUGE-2 F1: **7.14%**
  - ROUGE-L F1 (LCS): **20.13%**
  - Compression Ratio: **64.5%**
  - Average Latency: **~18 ms**

## Directory Structure
```
hindi_summarization/
├── agent.py               # Main HindiSummarizerAgent class & summarize_hindi() function
├── inference.py           # Standalone CLI / inference entry point
├── train.py               # Training pipeline with held-out ROUGE evaluation
├── train_transformer.py   # Optional advanced abstractive transformer fine-tuning script
├── rouge_metrics.py       # Self-contained Devanagari LCS ROUGE calculator
├── model/
│   ├── hindi_summarizer.joblib
│   └── hindi_summarizer_eval.json
└── data/
    ├── train.json
    ├── val.json
    ├── test.json
    ├── demo_data.json
    ├── generate_demo_data.py
    └── download_xlsum_hindi.py
```

## Quick Start

### 1. Run Standalone Inference
```bash
python agents/hindi_summarization/inference.py
```
Or pass custom Hindi text:
```bash
python agents/hindi_summarization/inference.py --text "यहाँ अपना हिंदी समाचार या लेख पेस्ट करें..." --sentences 2
```

### 2. Retrain Model
```bash
python agents/hindi_summarization/train.py
```

### 3. Python API Usage
```python
from agents.hindi_summarization.agent import summarize_hindi, HindiSummarizerAgent

# Functional API
result = summarize_hindi("भारतीय अंतरिक्ष अनुसंधान संगठन...", max_sentences=2)
print("Summary:", result["summary"])
print("Compression:", result["compression_ratio"])

# Object-Oriented API
agent = HindiSummarizerAgent()
res = agent.summarize("भारत में डिजिटल भुगतान...")
```
