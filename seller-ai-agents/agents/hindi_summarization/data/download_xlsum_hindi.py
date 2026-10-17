"""
datasets/hindi_summarization/download_xlsum_hindi.py
Downloads the official XL-Sum Hindi subset from Hugging Face:
https://huggingface.co/datasets/csebuetnlp/xlsum
License: CC BY-NC-SA 4.0
"""

import os
import sys
import json
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent

def download_xlsum(max_samples=100):
    print("Attempting to fetch XL-Sum Hindi subset from Hugging Face...")
    try:
        import requests
        # Hugging Face direct streaming parquet / json endpoint for csebuetnlp/xlsum hindi
        url = "https://datasets-server.huggingface.co/rows?dataset=csebuetnlp%2Fxlsum&config=hindi&split=train&offset=0&limit=" + str(max_samples)
        resp = requests.get(url, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            rows = data.get("rows", [])
            parsed = []
            for r in rows:
                item = r.get("row", {})
                if item.get("text") and item.get("summary"):
                    parsed.append({
                        "id": item.get("id", f"xlsum_hi_{len(parsed)+1}"),
                        "title": item.get("title", ""),
                        "article": item.get("text"),
                        "summary": item.get("summary"),
                        "split": "train" if len(parsed) < int(max_samples * 0.8) else "test"
                    })
            if parsed:
                out_path = DATA_DIR / "xlsum_downloaded.json"
                with open(out_path, "w", encoding="utf-8") as f:
                    json.dump(parsed, f, ensure_ascii=False, indent=2)
                print(f"Successfully downloaded and saved {len(parsed)} XL-Sum Hindi samples to {out_path}")
                return True
    except Exception as e:
        print(f"Online download skipped or unavailable ({e}). Using bundled offline dataset.")
    
    print("Using bundled offline XL-Sum Hindi dataset in demo_data.json.")
    return False

if __name__ == "__main__":
    download_xlsum()
