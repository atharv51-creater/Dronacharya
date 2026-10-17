"""
datasets/hindi_sentiment/download_mteb_hindi_sentiment.py
Downloads the official MTEB Hindi Sentiment dataset:
https://huggingface.co/datasets/mteb/SentimentAnalysisHindi
License: CC BY 4.0
"""

import sys
import json
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent

def download_mteb_sentiment(limit=200):
    print("Attempting to query MTEB SentimentAnalysisHindi dataset from Hugging Face...")
    try:
        import requests
        url = "https://datasets-server.huggingface.co/rows?dataset=mteb%2FSentimentAnalysisHindi&config=default&split=train&offset=0&limit=" + str(limit)
        res = requests.get(url, timeout=10)
        if res.status_code == 200:
            rows = res.json().get("rows", [])
            data = []
            for r in rows:
                row = r.get("row", {})
                text = row.get("text")
                label = row.get("label")
                if text is not None and label is not None:
                    label_map = {0: "negative", 1: "neutral", 2: "positive"}
                    data.append({
                        "text": text,
                        "label": int(label),
                        "label_text": label_map.get(int(label), "unknown"),
                        "split": "train" if len(data) < int(limit * 0.8) else "test"
                    })
            if data:
                out_path = DATA_DIR / "mteb_downloaded.json"
                with open(out_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                print(f"Successfully downloaded {len(data)} samples from MTEB Hindi Sentiment to {out_path}")
                return True
    except Exception as e:
        print(f"Online download skipped or unavailable ({e}).")
    
    print("Using bundled offline Hindi Sentiment dataset in demo_data.json.")
    return False

if __name__ == "__main__":
    download_mteb_sentiment()
