# Agent 3: Bhaavna Hindi Sentiment & Review Classifier

A standalone Hindi sentiment classification service supporting 3-class sentiment analysis with calibrated prediction probabilities.

## Overview
- **Service Name**: `hindi-sentiment-analyzer` (Bhaavna)
- **Model Type**: TF-IDF N-Gram Vectorizer + L2-Regularized Multinomial Logistic Regression
- **Dataset**: [MTEB Hindi Sentiment Benchmark](https://huggingface.co/datasets/mteb/SentimentAnalysisHindi) (CC BY 4.0)
- **Label Mapping**:
  - `0`: Negative (*नकारात्मक*) 😞
  - `1`: Neutral (*तटस्थ*) 😐
  - `2`: Positive (*सकारात्मक*) 😊
- **Held-Out Evaluation**:
  - Classification Accuracy: **66.67%**
  - Macro Precision: **50.00%**
  - Macro Recall: **66.67%**
  - Macro F1-Score: **55.56%**
  - Average Latency: **~12 ms**

## Directory Structure
```
hindi_sentiment/
├── agent.py               # Main HindiSentimentAgent class & analyze_hindi_sentiment() function
├── inference.py           # Standalone CLI / inference entry point
├── train.py               # Training pipeline with 3-class classification evaluation
├── model/
│   ├── hindi_sentiment.joblib
│   └── hindi_sentiment_eval.json
└── data/
    ├── train.json
    ├── val.json
    ├── test.json
    ├── demo_data.json
    ├── metadata.json
    ├── generate_demo_data.py
    └── download_mteb_hindi_sentiment.py
```

## Quick Start

### 1. Run Standalone Inference
```bash
python agents/hindi_sentiment/inference.py
```
Or with custom text:
```bash
python agents/hindi_sentiment/inference.py --text "यह सेवा बहुत ही घटिया और बेकार है, पैसे बर्बाद हो गए।"
```

### 2. Retrain Model
```bash
python agents/hindi_sentiment/train.py
```

### 3. Python API Usage
```python
from agents.hindi_sentiment.agent import analyze_hindi_sentiment, HindiSentimentAgent

# Functional API
result = analyze_hindi_sentiment("यह फोन बहुत ही कमाल का है!")
print("Sentiment:", result["sentiment"], result["emoji"])
print("Confidence:", result["confidence_percentage"])
print("Probabilities:", result["probabilities"])

# Object-Oriented API
agent = HindiSentimentAgent()
res = agent.analyze("डिलीवरी समय पर हुई, सामान ठीक-ठाक है।")
```
