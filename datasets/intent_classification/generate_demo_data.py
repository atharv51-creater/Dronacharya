"""
datasets/intent_classification/generate_demo_data.py
Generates Intent Classification dataset covering:
1. summarize_text (routes to Hindi Summarization Agent)
2. get_weather_prediction (routes to Weather Prediction Agent)
3. analyze_sentiment (routes to Hindi Sentiment Agent)
4. audit_payment_log (routes to AuditPay On-Chain Verifier)
5. out_of_scope (unsupported intent rejection)
Modeled on CLINC150 / OOS-eval structure.
"""

import json
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent

INTENT_SAMPLES = [
    # summarize_text
    {"text": "Can you summarize this long Hindi news article for me?", "intent": "summarize_text", "split": "train"},
    {"text": "कृपया इस संपादकीय लेख का संक्षिप्त सारांश तैयार करें।", "intent": "summarize_text", "split": "train"},
    {"text": "Generate a concise 3-sentence summary of this document.", "intent": "summarize_text", "split": "train"},
    {"text": "I need an extractive summary of this research paper.", "intent": "summarize_text", "split": "train"},
    {"text": "इस बड़े पैराग्राफ को छोटा करके मुख्य बिंदु बताएं।", "intent": "summarize_text", "split": "train"},
    {"text": "Provide an executive summary of this audit report.", "intent": "summarize_text", "split": "train"},
    {"text": "Can your AI condense this speech into key bullet points?", "intent": "summarize_text", "split": "val"},
    {"text": "हिंदी लेख का संक्षेपण करें ताकि जल्दी पढ़ा जा सके।", "intent": "summarize_text", "split": "test"},
    {"text": "Summarize this technical documentation into a brief overview.", "intent": "summarize_text", "split": "test"},

    # get_weather_prediction
    {"text": "What will be the temperature in Delhi tomorrow?", "intent": "get_weather_prediction", "split": "train"},
    {"text": "Predict tomorrow's maximum and minimum temperature.", "intent": "get_weather_prediction", "split": "train"},
    {"text": "Can you forecast the weather conditions for the next 24 hours?", "intent": "get_weather_prediction", "split": "train"},
    {"text": "Is it going to rain tomorrow based on current humidity levels?", "intent": "get_weather_prediction", "split": "train"},
    {"text": "कल का तापमान कितना रहने का अनुमान है?", "intent": "get_weather_prediction", "split": "train"},
    {"text": "Run a regression forecast on historical temperature trends.", "intent": "get_weather_prediction", "split": "train"},
    {"text": "What is the expected climate forecast for the weekend?", "intent": "get_weather_prediction", "split": "val"},
    {"text": "कल बारिश होने की क्या संभावना है?", "intent": "get_weather_prediction", "split": "test"},
    {"text": "Predict the next-day mean temperature from these sensor readings.", "intent": "get_weather_prediction", "split": "test"},

    # analyze_sentiment
    {"text": "Classify the sentiment of this customer product review.", "intent": "analyze_sentiment", "split": "train"},
    {"text": "क्या यह ग्राहक समीक्षा सकारात्मक है या नकारात्मक?", "intent": "analyze_sentiment", "split": "train"},
    {"text": "Detect if this user feedback is expressing frustration or satisfaction.", "intent": "analyze_sentiment", "split": "train"},
    {"text": "Determine the emotional polarity of this Hindi tweet.", "intent": "analyze_sentiment", "split": "train"},
    {"text": "इस फीडबैक में ग्राहक का क्या रुख है? सकारात्मक या असंतुष्ट?", "intent": "analyze_sentiment", "split": "train"},
    {"text": "Analyze the tone and sentiment score of these service ratings.", "intent": "analyze_sentiment", "split": "train"},
    {"text": "Is this restaurant review positive, negative, or neutral?", "intent": "analyze_sentiment", "split": "val"},
    {"text": "इस कमेंट का भाव विश्लेषण करके बताएं कि यह पॉजिटिव है या नेगेटिव।", "intent": "analyze_sentiment", "split": "test"},
    {"text": "Evaluate the customer sentiment on this warranty claim experience.", "intent": "analyze_sentiment", "split": "test"},

    # audit_payment_log
    {"text": "Verify this Algorand transaction hash in the audit log.", "intent": "audit_payment_log", "split": "train"},
    {"text": "Generate a cryptographic Merkle root audit certificate for my service.", "intent": "audit_payment_log", "split": "train"},
    {"text": "Check if this x402 payment settled on testnet indexer.", "intent": "audit_payment_log", "split": "train"},
    {"text": "Lookup the receipt proof for transaction ID K2QZ7J5Y6X4M8W1V.", "intent": "audit_payment_log", "split": "train"},
    {"text": "क्या इस ट्रांजेक्शन आईडी का पेमेंट ब्लॉकचेन पर रिकॉर्ड हो गया है?", "intent": "audit_payment_log", "split": "train"},
    {"text": "Export a tamper-evident audit report for this month's revenue.", "intent": "audit_payment_log", "split": "train"},
    {"text": "Authenticate the wallet signature against the registered service name.", "intent": "audit_payment_log", "split": "val"},
    {"text": "Download the PDF audit certificate for compliance verification.", "intent": "audit_payment_log", "split": "test"},
    {"text": "Check if there are any rejected payment attempts under my account.", "intent": "audit_payment_log", "split": "test"},

    # out_of_scope
    {"text": "Book a one-way flight from New York to London for next Tuesday.", "intent": "out_of_scope", "split": "train"},
    {"text": "Can you give me a recipe for authentic Italian sourdough pizza?", "intent": "out_of_scope", "split": "train"},
    {"text": "Who won the ICC cricket world cup in 2011?", "intent": "out_of_scope", "split": "train"},
    {"text": "Play some relaxing acoustic guitar music on Spotify.", "intent": "out_of_scope", "split": "train"},
    {"text": "What is the capital city of Australia?", "intent": "out_of_scope", "split": "train"},
    {"text": "Write a python program to invert a binary tree.", "intent": "out_of_scope", "split": "train"},
    {"text": "What are the latest stock market quotes for Apple and Tesla?", "intent": "out_of_scope", "split": "val"},
    {"text": "मुझे एक अच्छी बिरयानी बनाने की विधि बताएं।", "intent": "out_of_scope", "split": "test"},
    {"text": "Can you order groceries from the nearby supermarket?", "intent": "out_of_scope", "split": "test"},
]

def generate_intent_dataset():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    
    all_path = DATA_DIR / "demo_data.json"
    with open(all_path, "w", encoding="utf-8") as f:
        json.dump(INTENT_SAMPLES, f, ensure_ascii=False, indent=2)
    
    for split in ["train", "val", "test"]:
        split_items = [s for s in INTENT_SAMPLES if s["split"] == split]
        split_path = DATA_DIR / f"{split}.json"
        with open(split_path, "w", encoding="utf-8") as f:
            json.dump(split_items, f, ensure_ascii=False, indent=2)
        print(f"Intent Classification {split} split: {len(split_items)} samples")
    
    meta = {
        "dataset_name": "CLINC150-Aligned Marketplace Intent & OOS Dataset",
        "intents": [
            "summarize_text",
            "get_weather_prediction",
            "analyze_sentiment",
            "audit_payment_log",
            "out_of_scope"
        ],
        "target_service_mapping": {
            "summarize_text": "hindi-summarizer-ai",
            "get_weather_prediction": "weather-prediction-agent",
            "analyze_sentiment": "hindi-sentiment-analyzer",
            "audit_payment_log": "zk-proof-verifier",
            "out_of_scope": None
        },
        "license": "Creative Commons Attribution 4.0 International (CC BY 4.0)",
        "source": "https://github.com/clinc/oos-eval"
    }
    with open(DATA_DIR / "metadata.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)

if __name__ == "__main__":
    generate_intent_dataset()
