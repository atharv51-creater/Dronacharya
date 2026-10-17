# Agent 4: CogniRoute NLP Intent & Service Dispatcher

A standalone natural-language intent classification and service routing agent based on the CLINC150 / OOS-Eval architecture.

## Overview
- **Service Name**: `text-intent-router` (CogniRoute)
- **Model Type**: TF-IDF Vectorizer + Logistic Regression with Out-of-Scope (OOS) Confidence Thresholding
- **Dataset**: [CLINC150 / OOS-Eval Benchmark](https://github.com/clinc/oos-eval) (CC BY 3.0)
- **Marketplace Routing Map**:
  - `summarize_text` ➔ `hindi-summarizer-ai` (DivyaVaani Hindi Summarization)
  - `get_weather_prediction` ➔ `weather-prediction-agent` (MeteoCast Weather Predictor)
  - `analyze_sentiment` ➔ `hindi-sentiment-analyzer` (Bhaavna Hindi Sentiment)
  - `audit_payment_log` ➔ `zk-proof-verifier` (AuditPay Verification)
  - `out_of_scope` ➔ Unsupported Request
- **Held-Out Evaluation**:
  - Overall Accuracy: **50.00%**
  - Out-of-Scope (OOS) Detection Precision: **100.00%**
  - Macro F1-Score: **43.33%**
  - Confidence Gate: **0.30 Threshold**
  - Average Latency: **~15 ms**
- **Safety Principle**: Provides routing recommendations only. It does not bypass Buyer Agent evaluation or payment checks.

## Directory Structure
```
intent_classification/
├── agent.py               # Main IntentClassifierAgent class & classify_intent() function
├── inference.py           # Standalone CLI / inference entry point
├── train.py               # Training pipeline with OOS threshold evaluation
├── model/
│   ├── intent_classifier.joblib
│   └── intent_classifier_eval.json
└── data/
    ├── train.json
    ├── val.json
    ├── test.json
    ├── demo_data.json
    ├── metadata.json
    ├── generate_demo_data.py
    └── download_clinc150.py
```

## Quick Start

### 1. Run Standalone Inference
```bash
python agents/intent_classification/inference.py
```
Or test an out-of-scope query:
```bash
python agents/intent_classification/inference.py --query "Can you book me a flight ticket to London tonight?"
```

### 2. Retrain Model
```bash
python agents/intent_classification/train.py
```

### 3. Python API Usage
```python
from agents.intent_classification.agent import classify_intent, IntentClassifierAgent

# Functional API
result = classify_intent("What will be the temperature in Delhi tomorrow?")
print("Intent:", result["predicted_intent"])
print("Supported:", result["is_supported"])
print("Recommended Service:", result["recommended_service_title"])

# Object-Oriented API
agent = IntentClassifierAgent()
res = agent.classify("Please summarize this Hindi news article.")
```
